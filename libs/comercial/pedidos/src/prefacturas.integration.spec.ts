/**
 * Integración real del ciclo de la prefactura: Postgres (PgBouncer, app_comercial); archivos y personas simulados.
 * Crea su propio cliente, lista de precios y pedidos (`it_<n>`) y los elimina al final con dyn_migrator.
 *   RUN_INTEGRATION=1 npx nx test pedidos
 */
import { INestApplication, Module, ServiceUnavailableException } from '@nestjs/common';
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
import { TicketCerradoConsumer } from './consumers/ticket-cerrado.consumer';
import { TicketOperativoConsumer } from './consumers/ticket-operativo.consumer';
import { DirectorioPort } from './directorio/directorio.port';
import { OperacionesPort, type DocumentoTicketPumpingRef } from './directorio/operaciones.port';
import { PrismaService } from './prisma/prisma.service';
import {
  emitirGuiaDePrueba,
  quitarGuiasDePrueba,
  quitarMaestros,
  sembrarMaestros,
  type MaestrosDePrueba,
} from './testing/maestros';
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
const CLIENTE = uuidv7();
const COMPANY_MAN = uuidv7();
const BLOQUE_IT = { id: uuidv7(), nombre: `Bloque IT ${n}` };
const CAMPO_IT = { id: uuidv7(), nombre: `Campo IT ${n}` };
const POZO_NOMBRE = `ESTACION NORTE ${n}`;
const POZO_IT = { id: uuidv7(), nombre: POZO_NOMBRE, campoId: CAMPO_IT.id, bloqueId: BLOQUE_IT.id };
const PERSONA_IT = { id: uuidv7(), nombre: `Company Man IT ${n}` };
/** Registros reales que respaldan las FK (los inserta `beforeAll` y los quita `afterAll`). */
const MAESTROS: MaestrosDePrueba = {
  usuarios: [{ id: ACTOR, nombre: 'Fabiola Facturación', rol: 'facturacion' }],
  clientes: [{ id: CLIENTE, nombre: `Cliente IT ${n}`, ruc: `92${String(n).slice(-11)}` }],
  campos: [CAMPO_IT],
  bloques: [BLOQUE_IT],
  pozos: [POZO_IT],
  personas: [{ id: COMPANY_MAN, nombre: `Carlos Company Man ${n}` }],
};
const P = Permission;

run('prefactura (base de datos real)', () => {
  jest.setTimeout(90000);
  let app: INestApplication;
  let prisma: PrismaService;
  const admin = new Pool({ connectionString: MIGRATOR_DB, max: 2 });
  const http = () => request(app.getHttpServer());
  const signer = new JwtService({
    privateKey,
    signOptions: { algorithm: 'RS256', issuer: 'dynadrill-plataforma', expiresIn: 600 },
  });
  const bearer = (permissions: string[]) => ({
    Authorization: `Bearer ${signer.sign({ sub: ACTOR, email: 'it@test.local', roleId: 'r', roleCode: 'facturacion', permissions })}`,
  });
  const fact = () =>
    bearer([
      P.DOCUMENTOS_OPERATIVOS_ENVIAR,
      P.DOCUMENTOS_OPERATIVOS_VER,
      P.PREFACTURAS_VER,
      P.PREFACTURAS_GENERAR,
      P.PREFACTURAS_ENVIAR,
      P.PREFACTURAS_FIRMAR,
      P.PREFACTURAS_RECHAZAR,
    ]);
  const soloVer = () => bearer([P.PREFACTURAS_VER]);
  const pedidos: string[] = [];
  let cerrado: TicketCerradoConsumer;
  let ticketOperativo: TicketOperativoConsumer;
  const eventosCierre: string[] = [];
  let listaId = '';
  /** Valor real del espejo de PRC- antes de la prueba: se restaura al final (la prueba registra números de ejemplo). */
  let espejoOriginal: { id: string; actual: number } | null = null;

  const ocr: {
    respuesta: {
      resultado: 'firma_detectada' | 'no_detectada' | 'no_concluyente';
      confianza: number;
      nombreCoincide: boolean | null;
    } | null;
    llamadas: Array<{ archivoId: string; nombreEsperado?: string }>;
  } = {
    respuesta: { resultado: 'firma_detectada', confianza: 0.95, nombreCoincide: true },
    llamadas: [],
  };
  /** La lectura corre aparte: se espera a que quede el resultado (o el intento) en la firma. */
  const esperarVerificacion = async (prefacturaId: string, archivoId: string) => {
    for (let i = 0; i < 50; i++) {
      const f = await prisma.prefacturaFirma.findFirst({ where: { prefacturaId, archivoId } });
      if (f?.verificacionAt) return f;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('la verificación no terminó');
  };

  // archivos y personas simulados (el módulo real vive en plataforma)
  const ARCHIVO_OK = {
    id: uuidv7(),
    modulo: 'prefactura_documento',
    nombre: 'prefactura firmada.pdf',
    mimeType: 'application/pdf',
    tamanoBytes: 4096,
    subidoPor: ACTOR,
  };
  const ARCHIVO_2 = {
    id: uuidv7(),
    modulo: 'prefactura_documento',
    nombre: 'cliente.pdf',
    mimeType: 'application/pdf',
    tamanoBytes: 2048,
    subidoPor: ACTOR,
  };
  const ARCHIVO_AJENO = {
    id: uuidv7(),
    modulo: 'prefactura_documento',
    nombre: 'ajeno.pdf',
    mimeType: 'application/pdf',
    tamanoBytes: 10,
    subidoPor: uuidv7(),
  };
  const ARCHIVO_OTRO = {
    id: uuidv7(),
    modulo: 'pedido_documento',
    nombre: 'otro.pdf',
    mimeType: 'application/pdf',
    tamanoBytes: 10,
    subidoPor: ACTOR,
  };
  /** Documento firmado por el Company Man que el Supervisor sube desde el ticket. */
  const ARCHIVO_CM = {
    id: uuidv7(),
    modulo: 'prefactura_company_man',
    nombre: 'company man.pdf',
    mimeType: 'application/pdf',
    tamanoBytes: 3000,
    subidoPor: ACTOR,
  };
  /** Documento firmado nuevo que Facturación carga en lugar del registrado. */
  const ARCHIVO_NUEVO = {
    id: uuidv7(),
    modulo: 'prefactura_documento',
    nombre: 'prefactura firmada (nueva).pdf',
    mimeType: 'application/pdf',
    tamanoBytes: 5000,
    subidoPor: ACTOR,
  };
  /** Monitoreo o mezcla firmados (dos versiones). */
  const FIRMADO_1 = {
    id: uuidv7(),
    modulo: 'documento_respaldo_firmado',
    nombre: 'monitoreo firmado.pdf',
    mimeType: 'application/pdf',
    tamanoBytes: 1500,
    subidoPor: ACTOR,
  };
  const FIRMADO_2 = { ...FIRMADO_1, id: uuidv7(), nombre: 'monitoreo firmado v2.pdf' };
  // los archivos que se guardan de verdad (los otros se rechazan antes de guardarse)
  MAESTROS.archivos = [ARCHIVO_OK, ARCHIVO_2, ARCHIVO_CM, ARCHIVO_NUEVO, FIRMADO_1, FIRMADO_2];
  /** Los documentos que Pumping tiene en cada ticket (la consulta real va por HTTP a otro contenedor). */
  const ticketsPumping = new Map<string, DocumentoTicketPumpingRef[]>();
  const operaciones = { caido: false };
  const operacionesFalso = {
    documentosDeTicketPumping: async (ticketId: string) => {
      if (operaciones.caido) throw new ServiceUnavailableException('Pumping no responde');
      return ticketsPumping.get(ticketId) ?? null;
    },
  };
  const directorioFalso = {
    archivo: async (i: string) =>
      [
        ARCHIVO_OK,
        ARCHIVO_2,
        ARCHIVO_AJENO,
        ARCHIVO_OTRO,
        ARCHIVO_CM,
        ARCHIVO_NUEVO,
        FIRMADO_1,
        FIRMADO_2,
      ].find((a) => a.id === i) ?? null,
    persona: async (i: string) =>
      i === COMPANY_MAN ? { id: COMPANY_MAN, nombre: `Carlos Company Man ${n}` } : null,
    eliminarArchivo: async () => undefined,
    /** Lectura de firmas simulada: lo que responda `ocr.respuesta` (null = servicio no disponible). */
    verificarFirma: async (archivoId: string, params: { nombreEsperado?: string }) => {
      ocr.llamadas.push({ archivoId, nombreEsperado: params.nombreEsperado });
      return ocr.respuesta;
    },
  };

  /** Pedido FCR abierto de 2 días (1 y 2 de noviembre) con dos ítems estimados de la lista. */
  const pedido = async (conGuia = true) => {
    const l = await prisma.servicioLinea.findUniqueOrThrow({ where: { codigo: 'fcr' } });
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
        clienteId: CLIENTE,
        campoId: CAMPO_IT.id,
        pozoId: POZO_IT.id,
        rigless: true,
        numeroContrato: 'CT-IT',
        fechaInicioServicio: new Date('2026-11-01T00:00:00Z'),
        fechaFinServicio: new Date('2026-11-02T00:00:00Z'),
        agenteComercialId: ACTOR,
        tecnicoHseId: ACTOR,
        representanteCampoId: COMPANY_MAN,
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
          cantidad: 5,
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
    if (conGuia) await emitirGuiaDePrueba(admin, id, ACTOR);
    return id;
  };
  const doc = (cuerpo: object, id: string) =>
    http().post(`/api/comercial/pedidos/${id}/documentos-operativos`).set(fact()).send(cuerpo);
  const job = (d: number) => ({
    tipo: 'reporte_job',
    origen: 'fcr',
    fecha: `2026-11-0${d}`,
    actividades: [
      {
        fecha: `2026-11-0${d}`,
        horaInicio: '06:00',
        horaFin: '12:00',
        duracionHoras: 6,
        detalle: 'Trabajo',
      },
    ],
  });
  const herramientas = {
    tipo: 'reporte_herramientas',
    origen: 'fcr',
    herramientas: [
      {
        nombre: 'Cargo básico',
        serie: 'DY-1',
        codigo: `CT-${n}`,
        usos: [
          { fecha: '2026-11-01', estado: 'operacion' },
          { fecha: '2026-11-02', estado: 'daily_charge' },
        ],
      },
      { nombre: 'Sin código', usos: [{ fecha: '2026-11-01', estado: 'operacion' }] },
    ],
  };
  /** Un pedido con toda su documentación: llega solo a "documentos completos". */
  const pedidoListo = async () => {
    const id = await pedido();
    await doc(job(1), id).expect(201);
    await doc(job(2), id).expect(201);
    await doc(herramientas, id).expect(201);
    expect((await prisma.pedido.findUniqueOrThrow({ where: { id } })).estado).toBe(
      'documentos_completos',
    );
    return id;
  };
  const estadoDe = async (id: string) =>
    (await prisma.pedido.findUniqueOrThrow({ where: { id } })).estado;
  const generar = (id: string, cab = fact()) =>
    http().post(`/api/comercial/pedidos/${id}/prefacturas`).set(cab);

  beforeAll(async () => {
    await sembrarMaestros(admin, MAESTROS);
    Object.assign(process.env, {
      SERVICE_NAME: 'comercial-pref-test',
      PORT: '3193',
      LOG_LEVEL: 'silent',
      DATABASE_URL: APP_DB,
      RABBITMQ_URL: 'amqp://x:x@localhost:5672',
      JWT_PUBLIC_KEY: publicKey,
    });
    const envSchema = defineEnv(baseEnvSchema, databaseEnvSchema, jwtVerifyEnvSchema);

    @Module({
      imports: [
        AppConfigModule.forRoot(envSchema),
        CommonModule.forRoot({ serviceName: 'comercial-pref-test' }),
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
      .overrideProvider(OperacionesPort)
      .useValue(operacionesFalso)
      .compile();
    app = mod.createNestApplication();
    configureApp(app, { corsOrigins: ['http://localhost:4200'] });
    sinSuscripciones();
    await app.init();
    prisma = app.get(PrismaService);
    cerrado = app.get(TicketCerradoConsumer);
    ticketOperativo = app.get(TicketOperativoConsumer);

    const esp = await admin.query(
      `SELECT s.id, s.numero_actual FROM comercial.secuencia s JOIN comercial.documento d ON d.id = s.documento_id WHERE d.codigo = 'prefactura'`,
    );
    espejoOriginal = { id: esp.rows[0].id, actual: esp.rows[0].numero_actual };

    // lista de precios del cliente de prueba
    listaId = uuidv7();
    await prisma.listaPrecios.create({
      data: {
        id: listaId,
        clienteId: CLIENTE,
        numeroContrato: `IT-${n}`,
        vigenteDesde: new Date('2026-01-01T00:00:00Z'),
      },
    });
    await prisma.listaPreciosItem.createMany({
      data: [
        {
          id: uuidv7(),
          listaPreciosId: listaId,
          codigo: `SUP-${n}`,
          descripcion: 'Supervisor',
          unidad: 'día',
          precio: 437.23,
          tipo: 'Servicio',
        },
        {
          id: uuidv7(),
          listaPreciosId: listaId,
          codigo: `MOV-${n}`,
          descripcion: 'Movilización',
          unidad: 'Unidad',
          precio: 200,
          tipo: 'Servicio',
        },
        {
          id: uuidv7(),
          listaPreciosId: listaId,
          codigo: `CT-${n}`,
          descripcion: 'Cargo básico unidad',
          unidad: 'día',
          precio: 100,
          tipo: 'Servicio',
        },
      ],
    });
  });

  afterAll(async () => {
    if (eventosCierre.length) {
      await admin.query('DELETE FROM msg_comercial.inbox WHERE id = ANY($1::uuid[])', [
        eventosCierre,
      ]);
    }
    if (pedidos.length) {
      await quitarGuiasDePrueba(admin, pedidos);
      await admin.query(
        'DELETE FROM comercial.documento_respaldo_firmado WHERE pedido_id = ANY($1::uuid[])',
        [pedidos],
      );
      await admin.query(
        'DELETE FROM comercial.pedido_ticket_operativo WHERE pedido_id = ANY($1::uuid[])',
        [pedidos],
      );
      await admin.query(
        'DELETE FROM comercial.secuencia_emision WHERE documento_ref_id IN (SELECT id FROM comercial.prefactura WHERE pedido_id = ANY($1::uuid[]))',
        [pedidos],
      );
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
    if (espejoOriginal) {
      await admin.query(
        'UPDATE comercial.secuencia SET numero_actual = $2, as2_numero_actual = $2 WHERE id = $1',
        [espejoOriginal.id, espejoOriginal.actual],
      );
    }
    await admin.query('DELETE FROM comercial.lista_precios_item WHERE lista_precios_id = $1', [
      listaId,
    ]);
    await admin.query('DELETE FROM comercial.lista_precios WHERE id = $1', [listaId]);
    await quitarMaestros(admin, MAESTROS);
    await admin.end();
    await app.close();
  });

  it('genera la prefactura: calcula con la lista, los reportes y los ítems, avisa de lo que no se pudo facturar y mueve el pedido', async () => {
    const id = await pedidoListo();
    const r = await generar(id).expect(201);
    expect(r.body).toMatchObject({
      version: 1,
      estado: 'generada',
      ticketNumero: null,
      tasas: { ivaPct: 15, retencionIrPct: 1, retencionIvaPct: 30 },
    });
    const porCodigo = Object.fromEntries(
      r.body.items.map((i: { codigo: string }) => [i.codigo.split('-')[0], i]),
    );
    // herramienta CT: 2 días de renta (operación + stand by) a 100
    expect(porCodigo['CT']).toMatchObject({
      cantidad: 2,
      precioTotal: 200,
      fuente: 'herramienta',
      serie: 'DY-1',
    });
    // supervisor por día: los 2 días con Reporte Job (no los 5 cotizados) a 437,23
    expect(porCodigo['SUP']).toMatchObject({
      cantidad: 2,
      precioTotal: 874.46,
      fuente: 'personal',
    });
    // movilización con el 10 % de descuento acordado en el pedido
    expect(porCodigo['MOV']).toMatchObject({ cantidad: 1, descuentoPct: 10, precioTotal: 180 });
    // subtotal 1254,46 -> IVA 15 % 188,17; IR 1 % 12,54; retención de IVA 30 % 56,45
    expect(r.body.totales).toMatchObject({
      subtotalServicios: 1254.46,
      subtotalMateriales: 0,
      subtotal: 1254.46,
      iva: 188.17,
      retencionIr: 12.54,
      retencionIva: 56.45,
      netoCobrar: 1373.64,
    });
    // la herramienta sin código quedó avisada, no descartada en silencio
    expect(r.body.advertencias.join(' ')).toContain('"Sin código" no tiene código');
    expect(await estadoDe(id)).toBe('prefactura_generada');
    // una sola vigente por pedido
    await generar(id).expect(409);
  });

  it('el índice lista las prefacturas con su pedido y cliente, y filtra por estado y texto', async () => {
    const id = await pedidoListo();
    const gen = (await generar(id).expect(201)).body;
    const lista = (estado = '', q = '') =>
      http()
        .get('/api/comercial/prefacturas')
        .query({ ...(estado ? { estado } : {}), ...(q ? { q } : {}) })
        .set(fact());
    const fila = (await lista('generada').expect(200)).body.find(
      (f: { id: string }) => f.id === gen.id,
    );
    expect(fila).toMatchObject({
      pedidoId: id,
      version: 1,
      estado: 'generada',
      subtotal: 1254.46,
      netoCobrar: 1373.64,
    });
    expect(fila.pedidoCodigo).toBeTruthy();
    const porPedido = (await lista('', fila.pedidoCodigo).expect(200)).body;
    expect(porPedido.map((f: { id: string }) => f.id)).toContain(gen.id);
    expect((await lista('firmada', fila.pedidoCodigo).expect(200)).body).toEqual([]);
    await lista('inventado').expect(400);
    await http()
      .get('/api/comercial/prefacturas')
      .set(bearer([P.PEDIDOS_VER]))
      .expect(403);
  });

  it('la reportería trae una fila por pedido con su prefactura vigente, lo cotizado y las fechas de los hitos', async () => {
    const id = await pedidoListo();
    const gen = (await generar(id).expect(201)).body;
    const filas = (await http().get('/api/comercial/reporteria/pedidos').set(fact()).expect(200))
      .body;
    const fila = filas.find((f: { pedidoId: string }) => f.pedidoId === id);
    expect(fila).toMatchObject({
      estado: 'prefactura_generada',
      estadoNombre: 'Prefactura generada',
      prefactura: {
        id: gen.id,
        estado: 'generada',
        version: 1,
        subtotal: 1254.46,
        netoCobrar: 1373.64,
      },
      ordenTrabajoNumero: null,
    });
    expect(fila.guiaCodigo).toEqual(expect.any(String)); // la guía que deja emitida pedidoListo()
    expect(fila.cotizado).toBeGreaterThan(0);
    expect(fila.documentosCompletosAt).toEqual(expect.any(String));
    expect(fila.enviadoParaFirmasAt).toBeNull();
    // un borrador no entra en la reportería
    expect(filas.every((f: { estado: string }) => f.estado !== 'borrador')).toBe(true);
    await http()
      .get('/api/comercial/reporteria/pedidos')
      .set(bearer([P.PEDIDOS_VER]))
      .expect(403);
  });

  it('Facturación reemplaza el documento firmado: la lectura se repite, la anterior queda como historia y solo hay una vigente', async () => {
    const id = await pedidoListo();
    const p = (await generar(id).expect(201)).body;
    const url = `/api/comercial/prefacturas/${p.id}`;
    ocr.respuesta = { resultado: 'no_detectada', confianza: 0.2, nombreCoincide: false };
    const r = await http()
      .post(`${url}/firmas`)
      .set(fact())
      .send({
        firmanteTipo: 'company_man',
        personaId: COMPANY_MAN,
        firmadoAt: '2026-11-05',
        archivoId: ARCHIVO_OK.id,
      })
      .expect(201);
    const firmaId = r.body.firmas[0].id;
    expect((await esperarVerificacion(p.id, ARCHIVO_OK.id)).verificacion).toBe(
      'firma_no_detectada',
    );
    // sin permiso, con un archivo ajeno o con el mismo archivo no se reemplaza
    const rutaReemplazo = `${url}/firmas/${firmaId}/reemplazar`;
    await http()
      .post(rutaReemplazo)
      .set(soloVer())
      .send({ archivoId: ARCHIVO_NUEVO.id })
      .expect(403);
    await http().post(rutaReemplazo).set(fact()).send({ archivoId: ARCHIVO_AJENO.id }).expect(400);
    await http().post(rutaReemplazo).set(fact()).send({ archivoId: ARCHIVO_OK.id }).expect(409);
    // el reemplazo conserva a quien firma y se vuelve a leer
    ocr.respuesta = { resultado: 'firma_detectada', confianza: 0.93, nombreCoincide: true };
    const n2 = (
      await http().post(rutaReemplazo).set(fact()).send({ archivoId: ARCHIVO_NUEVO.id }).expect(201)
    ).body;
    expect(n2.firmas).toHaveLength(1);
    expect(n2.firmas[0]).toMatchObject({
      archivoId: ARCHIVO_NUEVO.id,
      firmanteTipo: 'company_man',
      nombre: `Carlos Company Man ${n}`,
    });
    expect((await esperarVerificacion(p.id, ARCHIVO_NUEVO.id)).verificacion).toBe(
      'firma_detectada',
    );
    // la anterior sigue en la base, enlazada a la que la reemplazó
    const vieja = await prisma.prefacturaFirma.findFirstOrThrow({
      where: { prefacturaId: p.id, archivoId: ARCHIVO_OK.id },
    });
    expect(vieja.reemplazadaPorId).toBe(n2.firmas[0].id);
    // una prefactura rechazada ya no admite reemplazos
    await http().post(`${url}/enviar`).set(fact()).send({ medio: 'email' }).expect(201);
    await http()
      .post(`${url}/rechazar`)
      .set(fact())
      .send({ motivo: 'Faltan soportes', devueltoA: 'operaciones' })
      .expect(201);
    await http()
      .post(`${url}/firmas/${n2.firmas[0].id}/reemplazar`)
      .set(fact())
      .send({ archivoId: ARCHIVO_2.id })
      .expect(409);
  });

  it('el monitoreo y la mezcla se cargan firmados con su indicador de firma; una versión nueva reemplaza a la anterior', async () => {
    const id = await pedidoListo();
    const base = `/api/comercial/pedidos/${id}/documentos-firmados`;
    const doc = uuidv7();
    const cuerpo = {
      tipo: 'monitoreo',
      documentoTicketId: doc,
      fecha: '2026-11-01',
      archivoId: FIRMADO_1.id,
    };
    // sin ticket de Pumping el pedido no tiene estos documentos
    await http().post(base).set(fact()).send(cuerpo).expect(409);
    const ticket = uuidv7();
    ticketsPumping.set(ticket, [{ id: doc, tipo: 'monitoreo', fecha: '2026-11-01' }]);
    await prisma.pedidoTicketOperativo.create({
      data: {
        pedidoId: id,
        origen: 'pumping',
        ticketId: ticket,
        pasoCodigo: 'ejecucion_operativa',
      },
    });
    // validaciones: permiso, fecha del monitoreo, archivo de otro módulo
    await http().post(base).set(soloVer()).send(cuerpo).expect(403);
    await http()
      .post(base)
      .set(fact())
      .send({ ...cuerpo, fecha: undefined })
      .expect(400);
    await http()
      .post(base)
      .set(fact())
      .send({ ...cuerpo, tipo: 'mezcla_quimica' })
      .expect(400);
    await http()
      .post(base)
      .set(fact())
      .send({ ...cuerpo, archivoId: ARCHIVO_OK.id })
      .expect(400);
    ocr.respuesta = { resultado: 'no_detectada', confianza: 0.1, nombreCoincide: null };
    const r = await http().post(base).set(fact()).send(cuerpo).expect(201);
    expect(r.body).toHaveLength(1);
    // la lectura no retrasa la carga: se espera a que termine
    let fila;
    for (let i = 0; i < 50 && !fila?.verificacionAt; i++) {
      await new Promise((x) => setTimeout(x, 100));
      fila = await prisma.documentoRespaldoFirmado.findFirst({
        where: { pedidoId: id, archivoId: FIRMADO_1.id },
      });
    }
    expect(fila?.verificacion).toBe('firma_no_detectada');
    // una versión nueva del mismo documento: queda una sola vigente, con su propio indicador
    ocr.respuesta = { resultado: 'firma_detectada', confianza: 0.9, nombreCoincide: null };
    const r2 = await http()
      .post(base)
      .set(fact())
      .send({ ...cuerpo, archivoId: FIRMADO_2.id })
      .expect(201);
    expect(r2.body).toHaveLength(1);
    expect(r2.body[0]).toMatchObject({
      archivoId: FIRMADO_2.id,
      tipo: 'monitoreo',
      fecha: '2026-11-01',
      documentoTicketId: doc,
    });
    for (let i = 0; i < 50; i++) {
      const g = await prisma.documentoRespaldoFirmado.findFirst({
        where: { pedidoId: id, archivoId: FIRMADO_2.id },
      });
      if (g?.verificacionAt) break;
      await new Promise((x) => setTimeout(x, 100));
    }
    const lista = (await http().get(base).set(fact()).expect(200)).body;
    expect(lista).toHaveLength(1);
    expect(lista[0]).toMatchObject({ archivoId: FIRMADO_2.id, verificacion: 'firma_detectada' });
    // la versión anterior se conserva como historia
    expect(await prisma.documentoRespaldoFirmado.count({ where: { pedidoId: id } })).toBe(2);
  });

  it('el documento firmado debe ser un documento del ticket de Pumping del pedido, del tipo y del día que se declara', async () => {
    const id = await pedidoListo();
    const base = `/api/comercial/pedidos/${id}/documentos-firmados`;
    const monitoreo = uuidv7();
    const mezcla = uuidv7();
    const deOtroTicket = uuidv7();
    const ticket = uuidv7();
    ticketsPumping.set(ticket, [
      { id: monitoreo, tipo: 'monitoreo', fecha: '2026-11-01' },
      { id: mezcla, tipo: 'mezcla_quimica', fecha: null },
    ]);
    ticketsPumping.set(uuidv7(), [{ id: deOtroTicket, tipo: 'monitoreo', fecha: '2026-11-01' }]);
    await prisma.pedidoTicketOperativo.create({
      data: {
        pedidoId: id,
        origen: 'pumping',
        ticketId: ticket,
        pasoCodigo: 'ejecucion_operativa',
      },
    });
    const cuerpo = {
      tipo: 'monitoreo',
      documentoTicketId: monitoreo,
      fecha: '2026-11-01',
      archivoId: FIRMADO_1.id,
    };
    const rechaza = async (c: object, mensaje: RegExp) => {
      const r = await http().post(base).set(fact()).send(c).expect(400);
      expect(r.body.detail ?? r.body.message).toMatch(mensaje);
    };
    // un documento de otro ticket, o que no existe, no se puede firmar aquí
    await rechaza({ ...cuerpo, documentoTicketId: deOtroTicket }, /no pertenece al ticket/);
    await rechaza({ ...cuerpo, documentoTicketId: uuidv7() }, /no pertenece al ticket/);
    // el tipo debe coincidir (la mezcla no es un monitoreo) y el día del monitoreo también
    await rechaza({ ...cuerpo, documentoTicketId: mezcla }, /es la mezcla química/);
    await rechaza({ ...cuerpo, fecha: '2026-11-02' }, /es del día 2026-11-01, no del 2026-11-02/);
    await rechaza(
      { tipo: 'mezcla_quimica', documentoTicketId: monitoreo, archivoId: FIRMADO_1.id },
      /es un monitoreo/,
    );
    expect(await prisma.documentoRespaldoFirmado.count({ where: { pedidoId: id } })).toBe(0);
    // si Pumping no responde no se acepta nada a ciegas
    operaciones.caido = true;
    try {
      await http().post(base).set(fact()).send(cuerpo).expect(503);
    } finally {
      operaciones.caido = false;
    }
    // un ticket que Pumping ya no tiene
    ticketsPumping.delete(ticket);
    await http().post(base).set(fact()).send(cuerpo).expect(409);
    // y con el documento correcto sí se acepta
    ticketsPumping.set(ticket, [{ id: monitoreo, tipo: 'monitoreo', fecha: '2026-11-01' }]);
    ocr.respuesta = { resultado: 'firma_detectada', confianza: 0.9, nombreCoincide: null };
    await http().post(base).set(fact()).send(cuerpo).expect(201);
  });

  it('con el Reporte de Herramientas por ítem la prefactura toma la cantidad REAL del reporte (menor que la cotizada) y lo cotizado no se factura', async () => {
    const id = await pedidoListo();
    // se cotizaron 5 días de supervisor y 1 movilización; el reporte dice que se usó 1 día de supervisor y 1 equipo; la movilización no se reportó
    await doc(
      {
        tipo: 'reporte_herramientas',
        origen: 'fcr',
        herramientas: [
          {
            nombre: 'Cargo básico',
            serie: 'DY-1',
            codigo: `CT-${n}`,
            unidad: 'día',
            cantidad: 1,
            usos: [{ fecha: '2026-11-01', estado: 'operacion' }],
          },
          {
            nombre: 'Supervisor',
            codigo: `SUP-${n}`,
            unidad: 'día',
            cantidad: 1,
            usos: [{ fecha: '2026-11-01', estado: 'operacion' }],
          },
        ],
      },
      id,
    ).expect(201);
    const r = (await generar(id).expect(201)).body;
    expect(
      r.items.map((i: { codigo: string; cantidad: number; precioTotal: number }) => [
        i.codigo,
        i.cantidad,
        i.precioTotal,
      ]),
    ).toEqual([
      [`CT-${n}`, 1, 100],
      [`SUP-${n}`, 1, 437.23],
    ]);
    expect(r.totales.subtotal).toBe(537.23);
    expect(r.advertencias.join(' ')).toContain(
      `El ítem cotizado MOV-${n} (1) no está en el Reporte de Herramientas`,
    );
  });

  it('no se genera sin la documentación completa ni sin permiso', async () => {
    const id = await pedido();
    const r = await generar(id).expect(422);
    expect(r.body.message).toContain('Falta: el Reporte Job');
    await generar(await pedidoListo(), soloVer()).expect(403);
    await generar(uuidv7()).expect(404);
  });

  it('ciclo completo: ticket de AS2, envío, firmas (company man y cliente), firmada; el ticket no se repite', async () => {
    const id = await pedidoListo();
    const p = (await generar(id).expect(201)).body;
    const url = `/api/comercial/prefacturas/${p.id}`;
    // el número que AS2 asignó (PRC-) es el ticket
    const t = await http()
      .post(`${url}/ticket`)
      .set(fact())
      .send({ numero: 90000 + (n % 1000) })
      .expect(201);
    expect(t.body.ticketNumero).toBe(90000 + (n % 1000));
    await http().post(`${url}/ticket`).set(fact()).send({ numero: 0 }).expect(400);
    // una vez puesto, el número no cambia
    await http().post(`${url}/ticket`).set(fact()).send({ numero: 90001 }).expect(409);
    // el espejo del secuencial PRC- de AS2 anota el número (y avanza al mayor registrado)
    const emision = await prisma.secuenciaEmision.findFirst({ where: { documentoRefId: p.id } });
    expect(emision).toMatchObject({
      numero: 90000 + (n % 1000),
      estado: 'emitido',
      codigoFormateado: `PRC-${String(90000 + (n % 1000)).padStart(5, '0')}`,
    });
    // no se firma ni se rechaza antes de enviar
    await http().post(`${url}/firmar`).set(fact()).send({}).expect(409);
    await http().post(`${url}/enviar`).set(fact()).send({ medio: 'whatsapp' }).expect(400);
    // sin guía de remisión emitida la prefactura no sale a firmas; con ella sí
    await quitarGuiasDePrueba(admin, [id]);
    const sinGuia = await http().post(`${url}/enviar`).set(fact()).send({ medio: 'email' });
    expect([sinGuia.status, sinGuia.body.code]).toEqual([409, 'GUIA_REQUERIDA']);
    await emitirGuiaDePrueba(admin, id, ACTOR);
    // firma de campo del company man asignado al pedido: se registra ANTES de enviar la prefactura al cliente
    await http()
      .post(`${url}/firmas`)
      .set(fact())
      .send({
        firmanteTipo: 'company_man',
        personaId: COMPANY_MAN,
        firmadoAt: '2026-11-05',
        archivoId: ARCHIVO_OK.id,
      })
      .expect(201);
    const env = await http().post(`${url}/enviar`).set(fact()).send({ medio: 'email' }).expect(201);
    expect(env.body).toMatchObject({ estado: 'enviada_para_firmas', medioEnvio: 'email' });
    expect(await estadoDe(id)).toBe('enviado_para_firmas');
    await http().post(`${url}/enviar`).set(fact()).send({ medio: 'email' }).expect(409);
    // archivo ajeno, de otro módulo o repetido: no
    await http()
      .post(`${url}/firmas`)
      .set(fact())
      .send({
        firmanteTipo: 'cliente',
        nombre: 'Cliente',
        firmadoAt: '2026-11-06',
        archivoId: ARCHIVO_AJENO.id,
      })
      .expect(400);
    await http()
      .post(`${url}/firmas`)
      .set(fact())
      .send({
        firmanteTipo: 'cliente',
        nombre: 'Cliente',
        firmadoAt: '2026-11-06',
        archivoId: ARCHIVO_OTRO.id,
      })
      .expect(400);
    await http()
      .post(`${url}/firmas`)
      .set(fact())
      .send({
        firmanteTipo: 'company_man',
        personaId: COMPANY_MAN,
        firmadoAt: '2026-11-05',
        archivoId: ARCHIVO_OK.id,
      })
      .expect(409);
    // un company man distinto al asignado al pedido no puede firmar como tal
    await http()
      .post(`${url}/firmas`)
      .set(fact())
      .send({
        firmanteTipo: 'company_man',
        personaId: uuidv7(),
        firmadoAt: '2026-11-05',
        archivoId: ARCHIVO_2.id,
      })
      .expect(400);
    await http()
      .post(`${url}/firmas`)
      .set(fact())
      .send({
        firmanteTipo: 'cliente',
        nombre: 'Representante del cliente',
        cargo: 'Gerente',
        firmadoAt: '2026-11-07',
        archivoId: ARCHIVO_2.id,
      })
      .expect(201);
    const fin = await http()
      .post(`${url}/firmar`)
      .set(fact())
      .send({ razonRetraso: 'El cliente tardó en revisar' })
      .expect(201);
    expect(fin.body).toMatchObject({
      estado: 'firmada',
      razonRetraso: 'El cliente tardó en revisar',
    });
    expect(
      fin.body.firmas.map((f: { firmanteTipo: string; nombre: string }) => [
        f.firmanteTipo,
        f.nombre,
      ]),
    ).toEqual([
      ['company_man', `Carlos Company Man ${n}`],
      ['cliente', 'Representante del cliente'],
    ]);
    expect(await estadoDe(id)).toBe('ticket_firmado');

    // el mismo número de ticket no puede estar en otra prefactura vigente
    const otro = await pedidoListo();
    const p2 = (await generar(otro).expect(201)).body;
    const repetido = await http()
      .post(`/api/comercial/prefacturas/${p2.id}/ticket`)
      .set(fact())
      .send({ numero: 90000 + (n % 1000) })
      .expect(409);
    expect(repetido.body.detail).toContain('ya está registrado');
    // fuera de lo que cabe en el código PRC- (5 dígitos)
    await http()
      .post(`/api/comercial/prefacturas/${p2.id}/ticket`)
      .set(fact())
      .send({ numero: 100000 })
      .expect(400);
  });

  it('la prefactura hereda el número de ticket que el pedido ya tenía; AS2 solo puede confirmar ese mismo número', async () => {
    const id = await pedidoListo();
    const numero = 70000 + (n % 1000);
    await prisma.pedido.update({ where: { id }, data: { ticketNumero: numero } });
    const p = (await generar(id).expect(201)).body;
    // la prefactura nace con el número del ticket, sin esperar a AS2
    expect(p.ticketNumero).toBe(numero);
    const url = `/api/comercial/prefacturas/${p.id}`;
    // un número distinto no se acepta: el ticket ya lo tiene
    const otro = await http()
      .post(`${url}/ticket`)
      .set(fact())
      .send({ numero: numero + 1 })
      .expect(409);
    expect(otro.body.detail).toContain(`ya tiene el número ${numero}`);
    // el mismo número (AS2 usó el reservado) se confirma sin error ni duplicado
    const igual = await http().post(`${url}/ticket`).set(fact()).send({ numero }).expect(201);
    expect(igual.body.ticketNumero).toBe(numero);
    // una nueva versión (tras un rechazo) conserva el mismo número
    await http().post(`${url}/enviar`).set(fact()).send({ medio: 'email' }).expect(201);
    await http()
      .post(`${url}/rechazar`)
      .set(fact())
      .send({ motivo: 'Faltan soportes', devueltoA: 'operaciones' })
      .expect(201);
    // tras el rechazo el pedido vuelve a corregirse; al terminar queda con la documentación completa otra vez
    await prisma.pedido.update({ where: { id }, data: { estado: 'documentos_completos' } });
    const v2 = (await generar(id).expect(201)).body;
    expect(v2).toMatchObject({ version: 2, ticketNumero: numero });
  });

  it('al registrar una firma se lee con el servicio de OCR sin retrasar el registro; el resultado es solo una ayuda', async () => {
    const id = await pedidoListo();
    const p = (await generar(id).expect(201)).body;
    const url = `/api/comercial/prefacturas/${p.id}`;
    ocr.llamadas = [];
    ocr.respuesta = { resultado: 'firma_detectada', confianza: 0.95, nombreCoincide: true };
    const r = await http()
      .post(`${url}/firmas`)
      .set(fact())
      .send({
        firmanteTipo: 'company_man',
        personaId: COMPANY_MAN,
        firmadoAt: '2026-11-05',
        archivoId: ARCHIVO_OK.id,
      })
      .expect(201);
    // la respuesta no espera a la lectura (la firma queda registrada de inmediato)
    expect(r.body.firmas).toHaveLength(1);
    expect(new Date(r.body.firmas[0].registradaAt).getTime()).toBeGreaterThan(Date.now() - 60_000);
    const f = await esperarVerificacion(p.id, ARCHIVO_OK.id);
    expect(f).toMatchObject({ verificacion: 'firma_detectada', nombreCoincide: true });
    expect(Number(f.verificacionConfianza)).toBe(0.95);
    // se pidió comparar con el nombre de quien firma
    expect(ocr.llamadas).toEqual([
      { archivoId: ARCHIVO_OK.id, nombreEsperado: `Carlos Company Man ${n}` },
    ]);

    // nueva lectura a pedido, con otro resultado
    ocr.respuesta = { resultado: 'no_detectada', confianza: 0.7, nombreCoincide: false };
    await http().post(`${url}/firmas/${f.id}/verificar`).set(fact()).expect(201);
    expect(await prisma.prefacturaFirma.findUniqueOrThrow({ where: { id: f.id } })).toMatchObject({
      verificacion: 'firma_no_detectada',
      nombreCoincide: false,
    });
    ocr.respuesta = { resultado: 'no_concluyente', confianza: 0.55, nombreCoincide: null };
    await http().post(`${url}/firmas/${f.id}/verificar`).set(fact()).expect(201);
    expect(
      (await prisma.prefacturaFirma.findUniqueOrThrow({ where: { id: f.id } })).verificacion,
    ).toBe('no_concluyente');

    // si el servicio no responde, queda constancia del intento y NADA falla (no bloquea la prefactura)
    ocr.respuesta = null;
    const g = await http()
      .post(`${url}/firmas`)
      .set(fact())
      .send({
        firmanteTipo: 'cliente',
        nombre: 'Representante del cliente',
        firmadoAt: '2026-11-06',
        archivoId: ARCHIVO_2.id,
      })
      .expect(201);
    expect(g.body.firmas).toHaveLength(2);
    const sin = await esperarVerificacion(p.id, ARCHIVO_2.id);
    expect(sin).toMatchObject({ verificacion: 'no_verificada', verificacionConfianza: null });
    await http().post(`${url}/enviar`).set(fact()).send({ medio: 'email' }).expect(201);
    await http().post(`${url}/firmar`).set(fact()).send({}).expect(201); // la verificación nunca es requisito
    await http().post(`${url}/firmas/${uuidv7()}/verificar`).set(fact()).expect(404);
    ocr.respuesta = { resultado: 'firma_detectada', confianza: 0.95, nombreCoincide: true };
  });

  it('sin ninguna firma registrada no se da por firmada', async () => {
    const id = await pedidoListo();
    const p = (await generar(id).expect(201)).body;
    await http()
      .post(`/api/comercial/prefacturas/${p.id}/enviar`)
      .set(fact())
      .send({ medio: 'portal' })
      .expect(201);
    const r = await http()
      .post(`/api/comercial/prefacturas/${p.id}/firmar`)
      .set(fact())
      .send({})
      .expect(422);
    expect(r.body.detail).toContain('Registre primero la firma');
    expect(await estadoDe(id)).toBe('enviado_para_firmas');
  });

  it('el rechazo del cliente conserva la prefactura, pasa el pedido a corrección y permite una versión nueva con el mismo ticket', async () => {
    const id = await pedidoListo();
    const v1 = (await generar(id).expect(201)).body;
    const ticket = 80000 + (n % 1000);
    await http()
      .post(`/api/comercial/prefacturas/${v1.id}/ticket`)
      .set(fact())
      .send({ numero: ticket })
      .expect(201);
    await http()
      .post(`/api/comercial/prefacturas/${v1.id}/enviar`)
      .set(fact())
      .send({ medio: 'portal' })
      .expect(201);
    await http()
      .post(`/api/comercial/prefacturas/${v1.id}/rechazar`)
      .set(fact())
      .send({ motivo: 'x', devueltoA: 'ventas' })
      .expect(400); // motivo muy corto
    await http()
      .post(`/api/comercial/prefacturas/${v1.id}/rechazar`)
      .set(fact())
      .send({ motivo: 'Cantidad de días incorrecta', devueltoA: 'otra' })
      .expect(400);
    const rec = await http()
      .post(`/api/comercial/prefacturas/${v1.id}/rechazar`)
      .set(fact())
      .send({ motivo: 'Cantidad de días incorrecta', devueltoA: 'operaciones' })
      .expect(201);
    expect(rec.body).toMatchObject({
      estado: 'rechazada',
      rechazo: { motivo: 'Cantidad de días incorrecta', devueltoA: 'operaciones' },
    });
    expect(await estadoDe(id)).toBe('en_correccion');
    const hist = await prisma.procesoHistorial.findMany({
      where: { entidadId: id },
      orderBy: { createdAt: 'asc' },
    });
    expect(hist.slice(-3).map((h) => h.estadoNuevo)).toEqual([
      'enviado_para_firmas',
      'rechazado_por_cliente',
      'en_correccion',
    ]);

    // corrección: vuelve a abierto (lo hace Ventas) y, con la documentación completa, se regenera
    await prisma.pedido.update({ where: { id }, data: { estado: 'abierto' } });
    const v2 = (await generar(id).expect(201)).body;
    expect(v2).toMatchObject({ version: 2, estado: 'generada', ticketNumero: ticket });
    const todas = (
      await http().get(`/api/comercial/pedidos/${id}/prefacturas`).set(soloVer()).expect(200)
    ).body;
    expect(todas.map((p: { version: number; estado: string }) => [p.version, p.estado])).toEqual([
      [2, 'generada'],
      [1, 'rechazada'],
    ]);
  });

  it('recalcular solo aplica a una prefactura recién generada y respeta los cambios del pedido', async () => {
    const id = await pedidoListo();
    const p = (await generar(id).expect(201)).body;
    await prisma.pedidoItem.updateMany({
      where: { pedidoId: id, orden: 1 },
      data: { descuentoPct: 0 },
    });
    const r = await http()
      .post(`/api/comercial/prefacturas/${p.id}/recalcular`)
      .set(fact())
      .expect(201);
    expect(r.body.items.find((i: { codigo: string }) => i.codigo.startsWith('MOV'))).toMatchObject({
      descuentoPct: 0,
      precioTotal: 200,
    });
    expect(r.body.totales.subtotal).toBe(1274.46);
    await http()
      .post(`/api/comercial/prefacturas/${p.id}/enviar`)
      .set(fact())
      .send({ medio: 'email' })
      .expect(201);
    await http().post(`/api/comercial/prefacturas/${p.id}/recalcular`).set(fact()).expect(409);
  });

  describe('desde el ticket (Supervisor)', () => {
    const sup = () => bearer([P.PREFACTURAS_VISTA_TICKET, P.PREFACTURAS_FIRMA_COMPANY_MAN]);
    const firma = {
      personaId: COMPANY_MAN,
      firmadoAt: '2026-11-03',
      archivoId: ARCHIVO_CM.id,
    };

    it('«ver prefactura»: una preliminar al vuelo (sin guardar ni mover el pedido) o la vigente', async () => {
      const id = await pedidoListo();
      await http().get(`/api/comercial/pedidos/${id}/prefactura-vista`).set(soloVer()).expect(403);
      const pre = (
        await http().get(`/api/comercial/pedidos/${id}/prefactura-vista`).set(sup()).expect(200)
      ).body;
      expect(pre.preliminar).toBe(true);
      expect(pre.prefactura.totales.subtotal).toBe(1254.46);
      expect(pre.avance.completo).toBe(true);
      // no guardó nada ni cambió el estado
      expect(await prisma.prefactura.count({ where: { pedidoId: id } })).toBe(0);
      expect(await estadoDe(id)).toBe('documentos_completos');
      // con una prefactura generada, devuelve esa
      await generar(id).expect(201);
      const vig = (
        await http().get(`/api/comercial/pedidos/${id}/prefactura-vista`).set(sup()).expect(200)
      ).body;
      expect(vig).toMatchObject({ preliminar: false, prefactura: { estado: 'generada' } });
    });

    it('la firma del Company Man genera la prefactura si no existe y deja el pedido en «ticket firmado»', async () => {
      const id = await pedidoListo();
      const r = await http()
        .post(`/api/comercial/pedidos/${id}/prefactura/firma-company-man`)
        .set(sup())
        .send(firma)
        .expect(201);
      expect(r.body).toMatchObject({ estado: 'firmada', version: 1 });
      expect(r.body.firmas).toHaveLength(1);
      expect(r.body.firmas[0]).toMatchObject({
        firmanteTipo: 'company_man',
        archivoId: ARCHIVO_CM.id,
      });
      expect(await estadoDe(id)).toBe('ticket_firmado');
      // no se firma dos veces
      await http()
        .post(`/api/comercial/pedidos/${id}/prefactura/firma-company-man`)
        .set(sup())
        .send(firma)
        .expect(409);
    });

    it('si la prefactura ya estaba generada se recalcula con los datos actuales antes de firmarla', async () => {
      const id = await pedidoListo();
      const p = (await generar(id).expect(201)).body;
      await prisma.pedidoItem.updateMany({
        where: { pedidoId: id, codigo: `MOV-${n}` },
        data: { cantidad: 2 },
      });
      const r = await http()
        .post(`/api/comercial/pedidos/${id}/prefactura/firma-company-man`)
        .set(sup())
        .send(firma)
        .expect(201);
      expect(r.body.id).toBe(p.id);
      expect(r.body.estado).toBe('firmada');
      expect(r.body.items.find((i: { codigo: string }) => i.codigo === `MOV-${n}`).cantidad).toBe(
        2,
      );
      expect(await estadoDe(id)).toBe('ticket_firmado');
    });

    it('sin la documentación completa no se firma, ni con un archivo que no es de este módulo', async () => {
      const incompleto = await pedido();
      const r = await http()
        .post(`/api/comercial/pedidos/${incompleto}/prefactura/firma-company-man`)
        .set(sup())
        .send(firma)
        .expect(422);
      expect(r.body.message).toContain('Falta:');
      const id = await pedidoListo();
      await http()
        .post(`/api/comercial/pedidos/${id}/prefactura/firma-company-man`)
        .set(sup())
        .send({ ...firma, archivoId: ARCHIVO_OTRO.id })
        .expect(400);
      await http()
        .post(`/api/comercial/pedidos/${id}/prefactura/firma-company-man`)
        .set(soloVer())
        .send(firma)
        .expect(403);
    });
  });

  describe('ticket operativo del pedido', () => {
    const evento = (type: string, pedidoId: string, ticketId: string, data: object = {}) => {
      const id = uuidv7();
      eventosCierre.push(id);
      return {
        id,
        type,
        version: 1,
        occurredAt: new Date().toISOString(),
        source: 'operaciones',
        subject: { type: 'pumping_ticket', id: ticketId },
        data: { ticketId, pedidoId, ...data },
      } as Parameters<TicketOperativoConsumer['consumir']>[0];
    };
    const fase = async (id: string) =>
      (
        await http()
          .get(`/api/comercial/pedidos/${id}`)
          .set(bearer([P.PEDIDOS_VER]))
          .expect(200)
      ).body.ticketOperativo;

    it('guarda el ticket de Operaciones y su paso; el detalle del pedido lo muestra', async () => {
      const id = await pedido();
      expect(await fase(id)).toBeNull();
      const ticket = uuidv7();
      await ticketOperativo.consumir(evento('operaciones.pumping.ticket_creado', id, ticket));
      expect(await fase(id)).toMatchObject({
        origen: 'pumping',
        ticketId: ticket,
        pasoCodigo: 'revision_inicial',
      });
      const mover = evento('operaciones.pumping.paso_cambiado', id, ticket, {
        desde: 'revision_inicial',
        hacia: 'asignacion',
      });
      await ticketOperativo.consumir(mover);
      await ticketOperativo.consumir(mover); // repetido: lo ignora el inbox
      expect(await fase(id)).toMatchObject({ pasoCodigo: 'asignacion' });
      // un ticket_creado que llega tarde no hace retroceder el paso
      await ticketOperativo.consumir(evento('operaciones.pumping.ticket_creado', id, ticket));
      expect(await fase(id)).toMatchObject({ pasoCodigo: 'asignacion' });
    });

    it('FCR trae su paso en el ticket creado y un pedido inexistente se ignora', async () => {
      const id = await pedido();
      const ticket = uuidv7();
      await ticketOperativo.consumir(
        evento('operaciones.fcr.ticket_creado', id, ticket, { paso: 'revision_inicial_fcr' }),
      );
      expect(await fase(id)).toMatchObject({ origen: 'fcr', pasoCodigo: 'revision_inicial_fcr' });
      await expect(
        ticketOperativo.consumir(
          evento('operaciones.pumping.paso_cambiado', uuidv7(), ticket, { hacia: 'asignacion' }),
        ),
      ).resolves.toBeUndefined();
    });
  });

  describe('al cerrar el ticket', () => {
    const cierre = (pedidoId: string, type = 'operaciones.pumping.cerrado') => {
      const id = uuidv7();
      eventosCierre.push(id);
      return {
        id,
        type,
        version: 1,
        occurredAt: new Date().toISOString(),
        source: 'operaciones',
        subject: { type: 'pumping_ticket', id: uuidv7() },
        actor: { userId: ACTOR, role: 'supervisor' },
        data: { ticketId: uuidv7(), pedidoId },
      } as Parameters<TicketCerradoConsumer['consumir']>[0];
    };

    it('genera la prefactura sola si la documentación está completa; un evento repetido no la duplica', async () => {
      const id = await pedidoListo();
      const e = cierre(id);
      await cerrado.consumir(e);
      expect(await estadoDe(id)).toBe('prefactura_generada');
      expect(await prisma.prefactura.count({ where: { pedidoId: id } })).toBe(1);
      await cerrado.consumir(e); // repetido: lo ignora el inbox
      await cerrado.consumir(cierre(id, 'operaciones.fcr.cerrado')); // otro evento: ya hay una vigente, se omite
      expect(await prisma.prefactura.count({ where: { pedidoId: id } })).toBe(1);
    });

    it('con la documentación incompleta se omite sin fallar y el pedido no cambia', async () => {
      const id = await pedido();
      await cerrado.consumir(cierre(id));
      expect(await prisma.prefactura.count({ where: { pedidoId: id } })).toBe(0);
      expect(await estadoDe(id)).toBe('abierto');
    });
  });
});
