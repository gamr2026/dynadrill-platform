/**
 * Integración real de la orden de trabajo (OT), el cierre del pedido y la exportación a AS2: Postgres (PgBouncer,
 * app_comercial); archivos simulados. Crea sus clientes, listas de precios y pedidos (`it_<n>`) y los elimina al final;
 * restaura el contador de la OT.
 *   RUN_INTEGRATION=1 npx nx test pedidos
 */
import { INestApplication, Module } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { generateKeyPairSync } from 'node:crypto';
import { Pool } from 'pg';
import request from 'supertest';
import { Permission } from '@dyn/authz';
import {
  AppConfigModule,
  baseEnvSchema,
  databaseEnvSchema,
  defineEnv,
  jwtVerifyEnvSchema,
} from '@dyn/config';
import { CommonModule, configureApp } from '@dyn/common';
import { MessagingModule } from '@dyn/messaging';
import { uuidv7 } from '@dyn/utils';
import { PedidosModule } from './index';
import { DirectorioPort } from './directorio/directorio.port';
import { PrismaService } from './prisma/prisma.service';
import { quitarMaestros, sembrarMaestros, type MaestrosDePrueba } from './testing/maestros';
import { sinSuscripciones } from './testing/sin-suscripciones';

const run = process.env['RUN_INTEGRATION'] ? describe : describe.skip;

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const APP_DB =
  process.env['TEST_COMERCIAL_DATABASE_URL'] ??
  'postgresql://app_comercial:dev_app_comercial@localhost:6432/dynadrill?pgbouncer=true';
const MIGRATOR_DB =
  process.env['TEST_MIGRATOR_DATABASE_URL'] ??
  'postgresql://dyn_migrator:dev_dyn_migrator@localhost:5433/dynadrill';

const n = Date.now();
const ACTOR = uuidv7();
const CLIENTE_OT = uuidv7(); // su contrato exige la OT
const CLIENTE_SIN = uuidv7(); // no la exige
const BLOQUE_IT = { id: uuidv7(), nombre: `Bloque IT ${n}` };
const CAMPO_IT = { id: uuidv7(), nombre: `Campo IT ${n}` };
const POZO_NOMBRE = `ESTACION NORTE ${n}`;
const POZO_IT = { id: uuidv7(), nombre: POZO_NOMBRE, campoId: CAMPO_IT.id, bloqueId: BLOQUE_IT.id };
const PERSONA_IT = { id: uuidv7(), nombre: `Company Man IT ${n}` };
/** Registros reales que respaldan las FK (los inserta `beforeAll` y los quita `afterAll`). */
const MAESTROS: MaestrosDePrueba = {
  usuarios: [{ id: ACTOR, nombre: 'Fabiola Facturación', rol: 'facturacion' }],
  clientes: [
    { id: CLIENTE_OT, nombre: `Cliente IT OT ${n}`, ruc: `91${String(n).slice(-11)}` },
    { id: CLIENTE_SIN, nombre: `Cliente IT sin OT ${n}`, ruc: `90${String(n).slice(-11)}` },
  ],
  campos: [CAMPO_IT],
  bloques: [BLOQUE_IT],
  pozos: [POZO_IT],
  personas: [{ id: PERSONA_IT.id, nombre: PERSONA_IT.nombre }],
};
const P = Permission;

run('orden de trabajo y cierre (base de datos real)', () => {
  jest.setTimeout(120000);
  let app: INestApplication;
  let prisma: PrismaService;
  const admin = new Pool({ connectionString: MIGRATOR_DB, max: 2 });
  const http = () => request(app.getHttpServer());
  const signer = new JwtService({
    privateKey,
    signOptions: { algorithm: 'RS256', issuer: 'dynadrill-plataforma', expiresIn: 600 },
  });
  const bearer = (permissions: string[]) => ({
    Authorization: `Bearer ${signer.sign({ sub: ACTOR, email: 'it@test.local', name: 'Fabiola Facturación', roleId: 'r', roleCode: 'facturacion', permissions })}`,
  });
  const fact = () =>
    bearer([
      P.DOCUMENTOS_OPERATIVOS_ENVIAR,
      P.DOCUMENTOS_OPERATIVOS_VER,
      P.PREFACTURAS_VER,
      P.PREFACTURAS_GENERAR,
      P.PREFACTURAS_ENVIAR,
      P.PREFACTURAS_FIRMAR,
      P.ORDENES_VER,
      P.ORDENES_EMITIR,
      P.ORDENES_FIRMAR,
      P.CIERRE_GESTIONAR,
    ]);
  const soloVer = () => bearer([P.ORDENES_VER, P.PREFACTURAS_VER]);

  const pedidos: string[] = [];
  const listas: string[] = [];
  let contadorOriginal: { id: string; actual: number } | null = null;

  const ARCHIVO_OT = {
    id: uuidv7(),
    modulo: 'orden_trabajo_documento',
    nombre: 'ot firmada.pdf',
    mimeType: 'application/pdf',
    tamanoBytes: 4096,
    subidoPor: ACTOR,
  };
  const ARCHIVO_PF = {
    id: uuidv7(),
    modulo: 'prefactura_documento',
    nombre: 'pf.pdf',
    mimeType: 'application/pdf',
    tamanoBytes: 4096,
    subidoPor: ACTOR,
  };
  const ARCHIVO_PF2 = {
    id: uuidv7(),
    modulo: 'prefactura_documento',
    nombre: 'pf2.pdf',
    mimeType: 'application/pdf',
    tamanoBytes: 4096,
    subidoPor: ACTOR,
  };
  const ARCHIVO_AJENO = {
    id: uuidv7(),
    modulo: 'orden_trabajo_documento',
    nombre: 'ajeno.pdf',
    mimeType: 'application/pdf',
    tamanoBytes: 10,
    subidoPor: uuidv7(),
  };
  // los archivos que se guardan de verdad (el ajeno se rechaza antes de guardarse)
  MAESTROS.archivos = [ARCHIVO_OT, ARCHIVO_PF, ARCHIVO_PF2];
  const directorioFalso = {
    archivo: async (i: string) =>
      [ARCHIVO_OT, ARCHIVO_PF, ARCHIVO_PF2, ARCHIVO_AJENO].find((a) => a.id === i) ?? null,
    persona: async () => null,
    eliminarArchivo: async () => undefined,
    verificarFirma: async () => null,
  };

  const crearLista = async (clienteId: string, requiere: boolean) => {
    const id = uuidv7();
    await prisma.listaPrecios.create({
      data: {
        id,
        clienteId,
        numeroContrato: `IT-${n}`,
        vigenteDesde: new Date('2026-01-01T00:00:00Z'),
        requiereOrdenTrabajo: requiere,
        textoContrato: requiere ? 'CONTRATO IT - SERVICIOS DE PRUEBA' : null,
      },
    });
    await prisma.listaPreciosItem.createMany({
      data: [
        {
          id: uuidv7(),
          listaPreciosId: id,
          codigo: `SUP-${n}`,
          descripcion: 'Supervisor',
          unidad: 'día',
          precio: 437.23,
          tipo: 'Servicio',
        },
        {
          id: uuidv7(),
          listaPreciosId: id,
          codigo: `MOV-${n}`,
          descripcion: 'Movilización',
          unidad: 'Unidad',
          precio: 200,
          tipo: 'Servicio',
        },
      ],
    });
    listas.push(id);
  };

  /** Pedido FCR con Reporte Job de 1 día; llega hasta "ticket firmado" por el camino real. */
  const pedidoFirmado = async (clienteId: string) => {
    const l = await prisma.servicioLinea.findUniqueOrThrow({ where: { codigo: 'pumping' } });
    const t = await prisma.tipoOt.findUniqueOrThrow({ where: { codigo: 'servicio' } });
    const id = uuidv7();
    await prisma.pedido.create({
      data: {
        id,
        codigo: `it_${n}_${pedidos.length}`,
        origen: 'portal',
        proceso: 'pedido',
        estado: 'abierto',
        lineaId: l.id,
        tipoOtId: t.id,
        clienteId,
        campoId: CAMPO_IT.id,
        pozoId: POZO_IT.id,
        rigless: true,
        numeroContrato: `IT-${n}`,
        fechaInicioServicio: new Date('2026-11-01T00:00:00Z'),
        fechaFinServicio: new Date('2026-11-01T00:00:00Z'),
        agenteComercialId: ACTOR,
        tecnicoHseId: ACTOR,
        representanteCampoId: PERSONA_IT.id,
      },
    });
    await prisma.pedidoItem.createMany({
      data: [
        {
          id: uuidv7(),
          pedidoId: id,
          orden: 0,
          codigo: `SUP-${n}`,
          descripcion: 'Supervisor',
          unidad: 'día',
          cantidad: 1,
          valorUnitario: 437.23,
        },
        {
          id: uuidv7(),
          pedidoId: id,
          orden: 1,
          codigo: `MOV-${n}`,
          descripcion: 'Movilización',
          unidad: 'Unidad',
          cantidad: 1,
          valorUnitario: 200,
          descuentoPct: 10,
        },
      ],
    });
    pedidos.push(id);
    await http()
      .post(`/api/comercial/pedidos/${id}/documentos-operativos`)
      .set(fact())
      .send({
        tipo: 'reporte_job',
        origen: 'pumping',
        fecha: '2026-11-01',
        actividades: [
          {
            fecha: '2026-11-01',
            horaInicio: '06:00',
            horaFin: '12:00',
            duracionHoras: 6,
            detalle: 'Trabajo',
          },
        ],
      })
      .expect(201);
    const pf = (
      await http().post(`/api/comercial/pedidos/${id}/prefacturas`).set(fact()).expect(201)
    ).body;
    const url = `/api/comercial/prefacturas/${pf.id}`;
    await http().post(`${url}/enviar`).set(fact()).send({ medio: 'email' }).expect(201);
    await http()
      .post(`${url}/firmas`)
      .set(fact())
      .send({
        firmanteTipo: 'cliente',
        nombre: 'Ing. Cliente Firma',
        cargo: 'Supervisor de Producción',
        firmadoAt: '2026-11-07',
        archivoId: ARCHIVO_PF.id,
      })
      .expect(201);
    await http().post(`${url}/firmar`).set(fact()).send({}).expect(201);
    expect(await estadoDe(id)).toBe('ticket_firmado');
    return { id, prefacturaId: pf.id as string };
  };
  const estadoDe = async (id: string) =>
    (await prisma.pedido.findUniqueOrThrow({ where: { id } })).estado;

  beforeAll(async () => {
    await sembrarMaestros(admin, MAESTROS);
    Object.assign(process.env, {
      SERVICE_NAME: 'comercial-ot-test',
      PORT: '3195',
      LOG_LEVEL: 'silent',
      DATABASE_URL: APP_DB,
      RABBITMQ_URL: 'amqp://x:x@localhost:5672',
      JWT_PUBLIC_KEY: publicKey,
    });
    const envSchema = defineEnv(baseEnvSchema, databaseEnvSchema, jwtVerifyEnvSchema);
    @Module({
      imports: [
        AppConfigModule.forRoot(envSchema),
        CommonModule.forRoot({ serviceName: 'comercial-ot-test' }),
        MessagingModule.forRoot({
          container: 'comercial',
          schema: 'msg_comercial',
          rabbitUrl: 'amqp://x:x@localhost:5672',
          databaseUrl: APP_DB,
          relay: { enabled: false },
        }),
        PedidosModule,
      ],
    })
    class TestAppModule {}
    const mod = await Test.createTestingModule({ imports: [TestAppModule] })
      .overrideProvider(DirectorioPort)
      .useValue(directorioFalso)
      .compile();
    app = mod.createNestApplication();
    configureApp(app, { corsOrigins: ['http://localhost:4200'] });
    sinSuscripciones();
    await app.init();
    prisma = app.get(PrismaService);
    const sec = await admin.query(
      `SELECT s.id, s.numero_actual FROM comercial.secuencia s JOIN comercial.documento d ON d.id = s.documento_id WHERE d.codigo = 'orden_trabajo'`,
    );
    contadorOriginal = { id: sec.rows[0].id, actual: sec.rows[0].numero_actual };
    await crearLista(CLIENTE_OT, true);
    await crearLista(CLIENTE_SIN, false);
  });

  afterAll(async () => {
    if (pedidos.length) {
      await admin.query(
        'DELETE FROM comercial.secuencia_emision WHERE documento_ref_id IN (SELECT id FROM comercial.orden_trabajo WHERE pedido_id = ANY($1::uuid[]))',
        [pedidos],
      );
      await admin.query('DELETE FROM comercial.orden_trabajo WHERE pedido_id = ANY($1::uuid[])', [
        pedidos,
      ]);
      await admin.query('DELETE FROM comercial.prefactura WHERE pedido_id = ANY($1::uuid[])', [
        pedidos,
      ]);
      await admin.query(
        'DELETE FROM comercial.documento_operativo WHERE pedido_id = ANY($1::uuid[])',
        [pedidos],
      );
      await admin.query('DELETE FROM comercial.pedido_item WHERE pedido_id = ANY($1::uuid[])', [
        pedidos,
      ]);
      await admin.query(
        'DELETE FROM comercial.proceso_historial WHERE entidad_id = ANY($1::uuid[])',
        [pedidos],
      );
      await admin.query('DELETE FROM comercial.pedido WHERE id = ANY($1::uuid[])', [pedidos]);
    }
    if (contadorOriginal) {
      await admin.query('UPDATE comercial.secuencia SET numero_actual = $2 WHERE id = $1', [
        contadorOriginal.id,
        contadorOriginal.actual,
      ]);
    }
    for (const l of listas) {
      await admin.query('DELETE FROM comercial.lista_precios_item WHERE lista_precios_id = $1', [
        l,
      ]);
      await admin.query('DELETE FROM comercial.lista_precios WHERE id = $1', [l]);
    }
    await quitarMaestros(admin, MAESTROS);
    await admin.end();
    await app.close();
  });

  it('genera la OT de la prefactura firmada con su número propio, la fecha del día anterior y el detalle de la prefactura', async () => {
    const { id, prefacturaId } = await pedidoFirmado(CLIENTE_OT);
    const antes = (
      await http().get(`/api/comercial/pedidos/${id}/orden-trabajo`).set(soloVer()).expect(200)
    ).body;
    expect(antes).toEqual({ requiere: true, orden: null });
    await http()
      .post(`/api/comercial/pedidos/${id}/orden-trabajo`)
      .set(soloVer())
      .send({})
      .expect(403);

    const r = await http()
      .post(`/api/comercial/pedidos/${id}/orden-trabajo`)
      .set(fact())
      .send({ descripcionRequerimiento: 'Limpieza de pozo' })
      .expect(201);
    expect(r.body.codigo).toBe(`${r.body.numero}-OPR-${POZO_NOMBRE}-UIO-2026`);
    expect(r.body.numero).toBe((contadorOriginal?.actual ?? 0) + 1);
    expect(r.body).toMatchObject({
      anio: 2026,
      fecha: '2026-10-31',
      fechaInicio: '2026-11-01',
      fechaTerminacion: '2026-11-01',
      estado: 'generada',
      servicio: `Limpieza de pozo /${POZO_NOMBRE}/RIGLESS`,
      textoContrato: 'CONTRATO IT - SERVICIOS DE PRUEBA',
      representanteContratista: { nombre: 'Ab. Mónica Rojas', cargo: 'Representante Legal' },
      // el representante del cliente sale de quien firmó la prefactura por el cliente
      representanteCliente: { nombre: 'Ing. Cliente Firma', cargo: 'Supervisor de Producción' },
    });
    expect(r.body.ciudad.codigo).toBe('UIO');
    // detalle = líneas de la prefactura; valor = suma de totales
    const pf = (
      await http().get(`/api/comercial/prefacturas/${prefacturaId}`).set(fact()).expect(200)
    ).body;
    expect(r.body.items).toHaveLength(pf.items.length);
    expect(r.body.valorOt).toBe(pf.totales.subtotal);
    expect(await estadoDe(id)).toBe('aot_generada');
    // una por pedido
    await http()
      .post(`/api/comercial/pedidos/${id}/orden-trabajo`)
      .set(fact())
      .send({})
      .expect(409);
    expect(
      (await http().get(`/api/comercial/pedidos/${id}/orden-trabajo`).set(soloVer()).expect(200))
        .body.orden.codigo,
    ).toBe(r.body.codigo);
    // el número queda en la bitácora de secuenciales
    const emision = await prisma.secuenciaEmision.findFirst({
      where: { documentoRefId: r.body.id },
    });
    expect(emision).toMatchObject({ numero: r.body.numero, estado: 'emitido' });
  });

  it('no se genera sin prefactura firmada, sin permiso, y el contrato que no la exige no la tiene', async () => {
    await http()
      .post(`/api/comercial/pedidos/${uuidv7()}/orden-trabajo`)
      .set(fact())
      .send({})
      .expect(404);
    const { id } = await pedidoFirmado(CLIENTE_SIN);
    expect(
      (await http().get(`/api/comercial/pedidos/${id}/orden-trabajo`).set(soloVer()).expect(200))
        .body,
    ).toEqual({ requiere: false, orden: null });
    const r = await http()
      .post(`/api/comercial/pedidos/${id}/orden-trabajo`)
      .set(fact())
      .send({})
      .expect(409);
    expect(r.body.detail).toContain('no requiere orden de trabajo');
    // un pedido que no llegó a "ticket firmado" tampoco
    const l = await prisma.servicioLinea.findUniqueOrThrow({ where: { codigo: 'pumping' } });
    const abierto = uuidv7();
    await prisma.pedido.create({
      data: {
        id: abierto,
        codigo: `it_${n}_x`,
        origen: 'portal',
        proceso: 'pedido',
        estado: 'borrador',
        lineaId: l.id,
        clienteId: CLIENTE_OT,
        pozoId: POZO_IT.id,
      },
    });
    pedidos.push(abierto);
    await http()
      .post(`/api/comercial/pedidos/${abierto}/orden-trabajo`)
      .set(fact())
      .send({})
      .expect(409);
  });

  it('marca la OT como firmada (firma física), con o sin archivo; el archivo debe ser propio y del módulo', async () => {
    const { id } = await pedidoFirmado(CLIENTE_OT);
    const ot = (
      await http()
        .post(`/api/comercial/pedidos/${id}/orden-trabajo`)
        .set(fact())
        .send({})
        .expect(201)
    ).body;
    const url = `/api/comercial/ordenes-trabajo/${ot.id}/firmada`;
    await http().post(url).set(soloVer()).send({}).expect(403);
    await http().post(url).set(fact()).send({ archivoId: ARCHIVO_AJENO.id }).expect(400);
    await http().post(url).set(fact()).send({ archivoId: ARCHIVO_PF2.id }).expect(400);
    const f = await http().post(url).set(fact()).send({ archivoId: ARCHIVO_OT.id }).expect(201);
    expect(f.body).toMatchObject({
      estado: 'firmada',
      firmada: { archivoId: ARCHIVO_OT.id, archivoNombre: 'ot firmada.pdf' },
    });
    await http().post(url).set(fact()).send({}).expect(409);
  });

  it('cierre con OT: control de costos → listo para facturar → facturado (con el número de factura), en orden y con permiso', async () => {
    const { id } = await pedidoFirmado(CLIENTE_OT);
    const base = `/api/comercial/pedidos/${id}/cierre`;
    // con el contrato que exige la OT no se salta
    const salto = await http().post(`${base}/control-costos`).set(fact()).expect(409);
    expect(salto.body.detail).toContain('exige la orden de trabajo');
    await http()
      .post(`/api/comercial/pedidos/${id}/orden-trabajo`)
      .set(fact())
      .send({})
      .expect(201);
    await http().post(`${base}/control-costos`).set(soloVer()).expect(403);
    await http().post(`${base}/listo-para-facturar`).set(fact()).expect(409);
    await http()
      .post(`${base}/facturado`)
      .set(fact())
      .send({ numeroFactura: '001-001-000001234' })
      .expect(409);
    expect((await http().post(`${base}/control-costos`).set(fact()).expect(201)).body.estado).toBe(
      'enviado_a_control_de_costos',
    );
    await http().post(`${base}/control-costos`).set(fact()).expect(409);
    expect(
      (await http().post(`${base}/listo-para-facturar`).set(fact()).expect(201)).body.estado,
    ).toBe('listo_para_facturar');
    await http().post(`${base}/facturado`).set(fact()).send({}).expect(400);
    const fin = await http()
      .post(`${base}/facturado`)
      .set(fact())
      .send({ numeroFactura: ' 001-001-000001234 ' })
      .expect(201);
    expect(fin.body).toMatchObject({ estado: 'facturado', facturaNumero: '001-001-000001234' });
    expect((await http().get(base).set(soloVer()).expect(200)).body.facturaNumero).toBe(
      '001-001-000001234',
    );
    await http()
      .post(`${base}/facturado`)
      .set(fact())
      .send({ numeroFactura: '001-001-000009999' })
      .expect(409);
    // el historial del pedido muestra todos los pasos por el motor de estados
    const pasos = await admin.query(
      'SELECT estado_nuevo FROM comercial.proceso_historial WHERE entidad_id = $1 ORDER BY id',
      [id],
    );
    expect(pasos.rows.map((p: { estado_nuevo: string }) => p.estado_nuevo)).toEqual(
      expect.arrayContaining([
        'ticket_firmado',
        'aot_generada',
        'enviado_a_control_de_costos',
        'listo_para_facturar',
        'facturado',
      ]),
    );
  });

  it('el cliente sin OT pasa directo de ticket firmado a control de costos', async () => {
    const { id } = await pedidoFirmado(CLIENTE_SIN);
    const r = await http()
      .post(`/api/comercial/pedidos/${id}/cierre/control-costos`)
      .set(fact())
      .expect(201);
    expect(r.body.estado).toBe('enviado_a_control_de_costos');
  });

  it('exporta a AS2 solo la prefactura firmada, con las columnas de la plantilla y avisos de lo que AS2 no reconocerá', async () => {
    const { prefacturaId } = await pedidoFirmado(CLIENTE_SIN);
    const e = (
      await http()
        .get(`/api/comercial/prefacturas/${prefacturaId}/exportacion-as2`)
        .set(soloVer())
        .expect(200)
    ).body;
    expect(e.prefacturaId).toBe(prefacturaId);
    expect(e.filas.length).toBeGreaterThan(0);
    expect(Object.keys(e.filas[0])).toEqual([
      'codigoProducto',
      'codigoUnidad',
      'cantidad',
      'descripcion',
      'precio',
      'porcentajeDescuento',
    ]);
    // movilización va en "Unidad" → UN; el supervisor va por día: sin código de AS2 confirmado
    const mov = e.filas.find((f: { codigoProducto: string }) => f.codigoProducto === `MOV-${n}`);
    expect(mov).toMatchObject({ codigoUnidad: 'UN', porcentajeDescuento: 10 });
    expect(e.advertencias.join(' ')).toContain('día');
    // una prefactura que no está firmada no se exporta
    const l = await prisma.servicioLinea.findUniqueOrThrow({ where: { codigo: 'pumping' } });
    const pid = uuidv7();
    await prisma.pedido.create({
      data: {
        id: pid,
        codigo: `it_${n}_y`,
        origen: 'portal',
        proceso: 'pedido',
        estado: 'borrador',
        lineaId: l.id,
        clienteId: CLIENTE_SIN,
      },
    });
    pedidos.push(pid);
    const pf = uuidv7();
    await prisma.prefactura.create({
      data: {
        id: pf,
        pedidoId: pid,
        version: 1,
        estado: 'generada',
        subtotalServicios: 0,
        subtotalMateriales: 0,
        subtotal: 0,
        iva: 0,
        retencionIr: 0,
        retencionIva: 0,
        netoCobrar: 0,
        ivaPct: 15,
        retencionIrPct: 1,
        retencionIvaPct: 30,
        generadaPor: ACTOR,
      },
    });
    await http().get(`/api/comercial/prefacturas/${pf}/exportacion-as2`).set(soloVer()).expect(409);
  });
});
