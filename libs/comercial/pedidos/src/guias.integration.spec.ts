/**
 * Integración real de la guía de remisión y el despacho a Bodega: Postgres (PgBouncer, app_comercial); archivos y
 * catálogos de transporte simulados. Crea su propio cliente, lista de precios y pedidos (`it_<n>`) y los elimina al
 * final con dyn_migrator; restaura el contador de la guía.
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
import { MessagingModule, type EventEnvelope } from '@dyn/messaging';
import { uuidv7 } from '@dyn/utils';
import { PedidosModule } from './index';
import { DespachoResultadoConsumer } from './consumers/despacho-resultado.consumer';
import { DirectorioPort } from './directorio/directorio.port';
import { PrismaService } from './prisma/prisma.service';
import { idsDeUnidades } from './testing/unidades';
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
const CLIENTE = uuidv7();
const P = Permission;

run('guía de remisión y despacho (base de datos real)', () => {
  jest.setTimeout(90000);
  let app: INestApplication;
  let prisma: PrismaService;
  /** Id de una unidad del catálogo por su nombre. */
  let U: (nombre: string) => string;
  const admin = new Pool({ connectionString: MIGRATOR_DB, max: 2 });
  const http = () => request(app.getHttpServer());
  const signer = new JwtService({
    privateKey,
    signOptions: { algorithm: 'RS256', issuer: 'dynadrill-plataforma', expiresIn: 600 },
  });
  const bearer = (permissions: string[], roleCode = 'facturacion') => ({
    Authorization: `Bearer ${signer.sign({ sub: ACTOR, email: 'it@test.local', name: 'Fabiola Facturación', roleId: 'r', roleCode, permissions })}`,
  });
  const fact = () =>
    bearer([
      P.DOCUMENTOS_OPERATIVOS_ENVIAR,
      P.DOCUMENTOS_OPERATIVOS_VER,
      P.PREFACTURAS_VER,
      P.PREFACTURAS_GENERAR,
      P.GUIAS_VER,
      P.GUIAS_EMITIR,
      P.GUIAS_FIRMAR,
      P.DESPACHO_SOLICITAR,
    ]);
  const bodega = () => bearer([P.GUIAS_VER, P.DESPACHOS_GESTIONAR], 'bodeguero');
  const soloVer = () => bearer([P.GUIAS_VER]);

  const pedidos: string[] = [];
  let listaId = '';
  let lugarId = '';
  let contadorOriginal: { id: string; actual: number } | null = null;

  const TRANSPORTISTA = {
    id: uuidv7(),
    nombre: `Transportes IT ${n}`,
    identificacion: `95${String(n).slice(-11)}`,
  };
  const OTRO_TRANSPORTISTA = {
    id: uuidv7(),
    nombre: `Otro Transporte ${n}`,
    identificacion: `94${String(n).slice(-11)}`,
  };
  const VEHICULO = {
    id: uuidv7(),
    placa: `IT${String(n).slice(-5)}A`,
    descripcion: 'CAMION JAC HFC1040K2',
    transportistaId: TRANSPORTISTA.id,
  };
  const VEHICULO_AJENO = {
    id: uuidv7(),
    placa: `IT${String(n).slice(-5)}B`,
    descripcion: 'CAMION CHEVROLET NQR',
    transportistaId: OTRO_TRANSPORTISTA.id,
  };
  const VEHICULO_SIN_DUENO = {
    id: uuidv7(),
    placa: `IT${String(n).slice(-5)}C`,
    descripcion: null,
    transportistaId: null,
  };
  const CHOFER = { id: uuidv7(), nombre: 'Chofer IT', transportistaId: TRANSPORTISTA.id };
  const CHOFER_AJENO = {
    id: uuidv7(),
    nombre: 'Chofer Ajeno',
    transportistaId: OTRO_TRANSPORTISTA.id,
  };
  const ARCHIVO_OK = {
    id: uuidv7(),
    modulo: 'guia_documento',
    nombre: 'guia firmada.pdf',
    mimeType: 'application/pdf',
    tamanoBytes: 4096,
    subidoPor: ACTOR,
  };
  const ARCHIVO_IMG = {
    id: uuidv7(),
    modulo: 'guia_documento',
    nombre: 'guia escaneada.png',
    mimeType: 'image/png',
    tamanoBytes: 2048,
    subidoPor: ACTOR,
  };
  const ARCHIVO_AJENO = {
    id: uuidv7(),
    modulo: 'guia_documento',
    nombre: 'ajena.pdf',
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
  /** Registros reales que respaldan las FK (los inserta `beforeAll` y los quita `afterAll`). */
  const BLOQUE = { id: uuidv7(), nombre: `Bloque IT ${n}` };
  const CAMPO = { id: uuidv7(), nombre: `Campo IT ${n}` };
  const POZO = { id: uuidv7(), nombre: `Pozo IT ${n}`, campoId: CAMPO.id, bloqueId: BLOQUE.id };
  const REP = { id: uuidv7(), nombre: `Company Man IT ${n}` };
  const MAESTROS: MaestrosDePrueba = {
    usuarios: [{ id: ACTOR, nombre: 'Fabiola Facturación', rol: 'facturacion' }],
    clientes: [{ id: CLIENTE, nombre: `Cliente IT ${n}`, ruc: `93${String(n).slice(-11)}` }],
    campos: [CAMPO],
    bloques: [BLOQUE],
    pozos: [POZO],
    personas: [REP],
    transportistas: [TRANSPORTISTA, OTRO_TRANSPORTISTA],
    vehiculos: [VEHICULO, VEHICULO_AJENO, VEHICULO_SIN_DUENO],
    choferes: [CHOFER, CHOFER_AJENO],
    // los archivos que se guardan de verdad (los otros se rechazan antes de guardarse)
    archivos: [ARCHIVO_OK, ARCHIVO_IMG],
  };
  const manuscrita: { respuesta: object | null } = {
    respuesta: { resultado: 'firma_detectada', confianza: 0.91, nombreCoincide: null },
  };
  /** La lectura manuscrita corre aparte: se espera a que quede el intento en la guía. */
  const esperarManuscrita = async (id: string) => {
    for (let i = 0; i < 50; i++) {
      const g = (await http().get(`/api/comercial/guias/${id}`).set(soloVer()).expect(200)).body;
      if (g.firmaManuscrita.at) return g.firmaManuscrita;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('la lectura no terminó');
  };
  const electronica: { respuesta: object | null } = {
    respuesta: {
      estado: 'firmantes_no_verificados',
      resumen: '1 de 1 firmantes no verificados',
      firmas: [
        {
          firmanteNombre: 'Fabiola Facturación',
          firmanteIdentificacion: '1712345678',
          emisor: 'Security Data',
          integridad: 'intacto',
          firmaValida: true,
          firmanteVerificado: false,
          vigenteAlFirmar: true,
          fechaFirma: '2026-11-03T10:00:00-05:00',
          origenFecha: 'declarada_por_el_firmante',
          conclusion: 'Íntegra, pero la cadena no llega a una raíz cargada',
        },
      ],
    },
  };
  /** La validación corre aparte: se espera a que quede el resultado en la guía. */
  const esperarElectronica = async (id: string) => {
    for (let i = 0; i < 50; i++) {
      const g = (await http().get(`/api/comercial/guias/${id}`).set(soloVer()).expect(200)).body;
      if (g.firmaElectronica) return g.firmaElectronica;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('la validación no terminó');
  };
  const directorioFalso = {
    archivo: async (i: string) =>
      [ARCHIVO_OK, ARCHIVO_IMG, ARCHIVO_AJENO, ARCHIVO_OTRO].find((a) => a.id === i) ?? null,
    persona: async () => null,
    eliminarArchivo: async () => undefined,
    /** Lectura de firma manuscrita simulada (null = servicio no disponible). */
    verificarFirma: async () => manuscrita.respuesta,
    /** Validación de firma electrónica simulada (null = servicio no disponible). */
    verificarFirmaElectronica: async () => electronica.respuesta,
    transportista: async (i: string) =>
      [TRANSPORTISTA, OTRO_TRANSPORTISTA].find((t) => t.id === i) ?? null,
    vehiculo: async (i: string) =>
      [VEHICULO, VEHICULO_AJENO, VEHICULO_SIN_DUENO].find((v) => v.id === i) ?? null,
    chofer: async (i: string) => [CHOFER, CHOFER_AJENO].find((c) => c.id === i) ?? null,
  };

  /** Pedido FCR abierto de 2 días con ítems de personal y un material de la lista. */
  const pedido = async () => {
    const l = await prisma.servicioLinea.findUniqueOrThrow({ where: { codigo: 'fcr' } });
    const t = await prisma.tipoOt.findUniqueOrThrow({ where: { codigo: 'servicio' } });
    const mat = await prisma.listaPreciosItem.findFirstOrThrow({
      where: { listaPreciosId: listaId, codigo: `MAT-${n}` },
    });
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
        campoId: CAMPO.id,
        pozoId: POZO.id,
        rigless: true,
        numeroContrato: 'CT-IT',
        fechaInicioServicio: new Date('2026-11-01T00:00:00Z'),
        fechaFinServicio: new Date('2026-11-02T00:00:00Z'),
        agenteComercialId: ACTOR,
        tecnicoHseId: ACTOR,
        representanteCampoId: REP.id,
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
          unidadMedidaId: U('Día'),
          cantidad: 5,
          valorUnitario: 437.23,
        },
        {
          id: uuidv7(),
          pedidoId: id,
          orden: 1,
          codigo: `MOV-${n}`,
          descripcion: 'Movilización',
          unidadMedidaId: U('Unidad'),
          cantidad: 1,
          valorUnitario: 200,
        },
        {
          id: uuidv7(),
          pedidoId: id,
          orden: 2,
          codigo: `MAT-${n}`,
          descripcion: 'Niple de prueba',
          unidadMedidaId: U('Unidad'),
          cantidad: 3,
          valorUnitario: 50,
          listaPreciosItemId: mat.id,
        },
      ],
    });
    pedidos.push(id);
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
        usos: [{ fecha: '2026-11-01', estado: 'operacion' }],
      },
      {
        nombre: 'Cargo básico',
        serie: 'DY-2',
        codigo: `CT-${n}`,
        usos: [{ fecha: '2026-11-01', estado: 'operacion' }],
      },
    ],
  };
  const pedidoConReportes = async () => {
    const id = await pedido();
    await doc(job(1), id).expect(201);
    await doc(job(2), id).expect(201);
    await doc(herramientas, id).expect(201);
    return id;
  };
  const cuerpoGuia = (extra: object = {}) => ({
    fecha: '2026-11-03',
    lugarOrigenId: lugarId,
    transportistaId: TRANSPORTISTA.id,
    vehiculoId: VEHICULO.id,
    choferId: CHOFER.id,
    horaSalida: '07:30',
    items: [
      {
        codigo: 'X-1',
        descripcion: 'Cargo básico',
        cantidad: 1,
        unidad: 'Unidad',
        serie: 'DY-1',
        origen: 'herramienta',
      },
    ],
    ...extra,
  });
  const emitir = (id: string, cuerpo: object = cuerpoGuia(), cab = fact()) =>
    http().post(`/api/comercial/pedidos/${id}/guias`).set(cab).send(cuerpo);
  const estadoDe = async (id: string) =>
    (await prisma.pedido.findUniqueOrThrow({ where: { id } })).estado;

  beforeAll(async () => {
    Object.assign(process.env, {
      SERVICE_NAME: 'comercial-guia-test',
      PORT: '3194',
      LOG_LEVEL: 'silent',
      DATABASE_URL: APP_DB,
      RABBITMQ_URL: 'amqp://x:x@localhost:5672',
      JWT_PUBLIC_KEY: publicKey,
    });
    const envSchema = defineEnv(baseEnvSchema, databaseEnvSchema, jwtVerifyEnvSchema);
    await sembrarMaestros(admin, MAESTROS);

    @Module({
      imports: [
        AppConfigModule.forRoot(envSchema),
        CommonModule.forRoot({ serviceName: 'comercial-guia-test' }),
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
    U = await idsDeUnidades(prisma);

    const sec = await admin.query(
      `SELECT s.id, s.numero_actual FROM comercial.secuencia s JOIN comercial.documento d ON d.id = s.documento_id WHERE d.codigo = 'guia_remision'`,
    );
    contadorOriginal = { id: sec.rows[0].id, actual: sec.rows[0].numero_actual };

    lugarId = uuidv7();
    await prisma.lugarDespacho.create({ data: { id: lugarId, nombre: `Lugar IT ${n}` } });
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
          unidadMedidaId: U('Día'),
          precio: 437.23,
          tipo: 'Servicio',
        },
        {
          id: uuidv7(),
          listaPreciosId: listaId,
          codigo: `MOV-${n}`,
          descripcion: 'Movilización',
          unidadMedidaId: U('Unidad'),
          precio: 200,
          tipo: 'Servicio',
        },
        {
          id: uuidv7(),
          listaPreciosId: listaId,
          codigo: `CT-${n}`,
          descripcion: 'Cargo básico unidad',
          unidadMedidaId: U('Día'),
          precio: 100,
          tipo: 'Servicio',
        },
        {
          id: uuidv7(),
          listaPreciosId: listaId,
          codigo: `MAT-${n}`,
          descripcion: 'Niple de prueba',
          unidadMedidaId: U('Unidad'),
          precio: 50,
          tipo: 'Material',
        },
      ],
    });
  });

  afterAll(async () => {
    if (pedidos.length) {
      await admin.query(
        'DELETE FROM comercial.secuencia_emision WHERE documento_ref_id IN (SELECT id FROM comercial.guia_remision WHERE pedido_id = ANY($1::uuid[]))',
        [pedidos],
      );
      await admin.query(
        'UPDATE comercial.guia_remision SET reemplaza_a_id = NULL WHERE pedido_id = ANY($1::uuid[])',
        [pedidos],
      );
      await admin.query('DELETE FROM comercial.guia_remision WHERE pedido_id = ANY($1::uuid[])', [
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
      // las emisiones de prueba ya se borraron: el contador vuelve a su valor real
      await admin.query('UPDATE comercial.secuencia SET numero_actual = $2 WHERE id = $1', [
        contadorOriginal.id,
        contadorOriginal.actual,
      ]);
    }
    await admin.query('DELETE FROM comercial.lugar_despacho WHERE id = $1', [lugarId]);
    await admin.query('DELETE FROM comercial.lista_precios_item WHERE lista_precios_id = $1', [
      listaId,
    ]);
    await admin.query('DELETE FROM comercial.lista_precios WHERE id = $1', [listaId]);
    await quitarMaestros(admin, MAESTROS);
    await admin.end();
    await app.close();
  });

  it('propone lo que sale físicamente: herramientas con serie y materiales del pedido, sin personal ni movilización', async () => {
    const id = await pedidoConReportes();
    const r = await http()
      .get(`/api/comercial/pedidos/${id}/guias/items-sugeridos`)
      .set(soloVer())
      .expect(200);
    expect(r.body).toEqual([
      {
        codigo: `CT-${n}`,
        descripcion: 'Cargo básico',
        cantidad: 1,
        unidad: 'Unidad',
        serie: 'DY-1',
        origen: 'herramienta',
      },
      {
        codigo: `CT-${n}`,
        descripcion: 'Cargo básico',
        cantidad: 1,
        unidad: 'Unidad',
        serie: 'DY-2',
        origen: 'herramienta',
      },
      {
        codigo: `MAT-${n}`,
        descripcion: 'Niple de prueba',
        cantidad: 3,
        unidad: 'Unidad',
        origen: 'material',
      },
    ]);
    await http()
      .get(`/api/comercial/pedidos/${uuidv7()}/guias/items-sugeridos`)
      .set(soloVer())
      .expect(404);
  });

  it('con el reporte por ítem la guía sigue la cantidad real: cada equipo con su serie, el material con lo usado, y sin servicios por día, km u horas', async () => {
    const id = await pedido();
    await doc(job(1), id).expect(201);
    await doc(
      {
        tipo: 'reporte_herramientas',
        origen: 'fcr',
        herramientas: [
          {
            nombre: 'Cargo básico',
            serie: 'DY-9',
            codigo: `CT-${n}`,
            unidadMedidaId: U('Día'),
            cantidad: 2,
            usos: [
              { fecha: '2026-11-01', estado: 'operacion' },
              { fecha: '2026-11-02', estado: 'daily_charge' },
            ],
          },
          {
            nombre: 'Niple',
            codigo: `MAT-${n}`,
            unidadMedidaId: U('Unidad'),
            cantidad: 2,
            usos: [],
          },
          {
            nombre: 'Supervisor',
            codigo: `SUP-${n}`,
            unidadMedidaId: U('Día'),
            cantidad: 3,
            usos: [
              { fecha: '2026-11-01', estado: 'operacion' },
              { fecha: '2026-11-02', estado: 'operacion' },
              { fecha: '2026-11-03', estado: 'operacion' },
            ],
          },
          {
            nombre: 'Movilización',
            codigo: `MOV-${n}`,
            unidadMedidaId: U('Kilómetro'),
            cantidad: 115,
            usos: [],
          },
        ],
      },
      id,
    ).expect(201);
    const r = await http()
      .get(`/api/comercial/pedidos/${id}/guias/items-sugeridos`)
      .set(soloVer())
      .expect(200);
    // el equipo viaja una vez (1 unidad con su serie, no 2 días); el material, con la cantidad del reporte (2) y no la cotizada (3)
    expect(r.body).toEqual([
      {
        codigo: `CT-${n}`,
        descripcion: 'Cargo básico unidad',
        cantidad: 1,
        unidad: 'Unidad',
        serie: 'DY-9',
        origen: 'herramienta',
      },
      {
        codigo: `MAT-${n}`,
        descripcion: 'Niple de prueba',
        cantidad: 2,
        unidad: 'Unidad',
        origen: 'material',
      },
    ]);
  });

  it('emite con el siguiente número del secuencial (003-001-), con los ítems editados, y alimenta el avance', async () => {
    const id = await pedidoConReportes();
    const antes = (
      await http()
        .get(`/api/comercial/pedidos/${id}/documentos-operativos/avance`)
        .set(fact())
        .expect(200)
    ).body;
    expect(antes).toMatchObject({ guiaRegistrada: false, guiaSugerida: true });
    const r = await emitir(
      id,
      cuerpoGuia({ observaciones: 'Entrega en bodega del cliente' }),
    ).expect(201);
    expect(r.body.codigo).toMatch(/^003-001-\d{7}$/);
    expect(r.body).toMatchObject({
      estado: 'emitida',
      fecha: '2026-11-03',
      clienteNombre: `Cliente IT ${n}`,
      lugarOrigen: { nombre: `Lugar IT ${n}` },
      transportista: { nombre: TRANSPORTISTA.nombre, identificacion: TRANSPORTISTA.identificacion },
      vehiculo: { placa: VEHICULO.placa, descripcion: 'CAMION JAC HFC1040K2' },
      chofer: { nombre: 'Chofer IT' },
      horaSalida: '07:30',
    });
    expect(r.body.items).toHaveLength(1);
    expect(r.body.items[0]).toMatchObject({
      orden: 1,
      serie: 'DY-1',
      cantidad: 1,
      unidad: 'Unidad',
      origen: 'herramienta',
    });
    expect(Number(r.body.codigo.slice(8))).toBe(r.body.numero);
    // el avance ya la ve; no lleva precios
    const despues = (
      await http()
        .get(`/api/comercial/pedidos/${id}/documentos-operativos/avance`)
        .set(fact())
        .expect(200)
    ).body;
    expect(despues.guiaRegistrada).toBe(true);
    expect(JSON.stringify(r.body)).not.toMatch(/precio|valorUnitario/);
    // lista y detalle
    expect(
      (await http().get(`/api/comercial/pedidos/${id}/guias`).set(soloVer()).expect(200)).body,
    ).toHaveLength(1);
    await http().get(`/api/comercial/guias/${r.body.id}`).set(soloVer()).expect(200);
    // el siguiente sale correlativo
    const otra = await emitir(id).expect(201);
    expect(otra.body.numero).toBe(r.body.numero + 1);
  });

  it('valida: transporte, chofer del transportista, hora, ítems, lugar, permiso y pedido en etapa', async () => {
    const id = await pedidoConReportes();
    await emitir(id, cuerpoGuia({ transportistaId: uuidv7() })).expect(400);
    await emitir(id, cuerpoGuia({ vehiculoId: uuidv7() })).expect(400);
    // el chofer y el vehículo deben ser del transportista elegido
    const ajeno = await emitir(id, cuerpoGuia({ choferId: CHOFER_AJENO.id })).expect(400);
    expect(ajeno.body.detail ?? ajeno.body.message).toContain('chofer no pertenece');
    const ajenoV = await emitir(id, cuerpoGuia({ vehiculoId: VEHICULO_AJENO.id })).expect(400);
    expect(ajenoV.body.detail ?? ajenoV.body.message).toContain('vehículo no pertenece');
    // un vehículo sin dueño en el catálogo se acepta; el de otro transportista viaja con el suyo
    await emitir(id, cuerpoGuia({ vehiculoId: VEHICULO_SIN_DUENO.id })).expect(201);
    await emitir(
      id,
      cuerpoGuia({
        transportistaId: OTRO_TRANSPORTISTA.id,
        vehiculoId: VEHICULO_AJENO.id,
        choferId: CHOFER_AJENO.id,
      }),
    ).expect(201);
    await emitir(
      id,
      cuerpoGuia({ transportistaId: OTRO_TRANSPORTISTA.id, choferId: CHOFER.id }),
    ).expect(400);
    await emitir(id, cuerpoGuia({ horaSalida: '25:00' })).expect(400);
    await emitir(id, cuerpoGuia({ items: [] })).expect(400);
    await emitir(
      id,
      cuerpoGuia({ items: [{ descripcion: 'X', cantidad: 0, unidad: 'u', origen: 'manual' }] }),
    ).expect(400);
    await emitir(id, cuerpoGuia({ lugarOrigenId: uuidv7() })).expect(400);
    await emitir(id, cuerpoGuia(), soloVer()).expect(403);
    await emitir(uuidv7()).expect(404);
    // ítems manuales sí se aceptan (se puede agregar a lo propuesto)
    await emitir(
      id,
      cuerpoGuia({
        items: [
          { descripcion: 'Caja de repuestos', cantidad: 2, unidad: 'Caja', origen: 'manual' },
        ],
      }),
    ).expect(201);
    // un pedido anulado no recibe guía
    const anulado = await pedido();
    await prisma.pedido.update({ where: { id: anulado }, data: { estado: 'anulado' } });
    await emitir(anulado).expect(409);
  });

  it('con número a mano: no se repite y el contador avanza; reasignar con motivo anula el anterior sin reutilizarlo', async () => {
    const id = await pedidoConReportes();
    const base = 8_000_000 + (n % 100_000);
    const a = await emitir(id, cuerpoGuia({ numero: base })).expect(201);
    expect(a.body).toMatchObject({ numero: base, codigo: `003-001-${base}` });
    // el mismo número no se emite dos veces, ni a mano ni por reasignación
    await emitir(id, cuerpoGuia({ numero: base })).expect(409);
    // el contador avanzó hasta él: el siguiente automático no lo duplica
    const sig = await emitir(id).expect(201);
    expect(sig.body.numero).toBe(base + 1);
    // reasignar exige motivo y un número libre
    const url = `/api/comercial/guias/${a.body.id}/reasignar-numero`;
    await http()
      .post(url)
      .set(fact())
      .send({ numero: base + 10 })
      .expect(400);
    await http()
      .post(url)
      .set(fact())
      .send({ numero: base + 1, motivo: 'error de digitación' })
      .expect(409);
    const nuevo = await http()
      .post(url)
      .set(fact())
      .send({ numero: base + 10, motivo: 'error de digitación' })
      .expect(201);
    expect(nuevo.body).toMatchObject({ numero: base + 10, codigo: `003-001-${base + 10}` });
    const viejo = await prisma.secuenciaEmision.findFirst({
      where: { numero: base, codigoFormateado: `003-001-${base}` },
    });
    expect(viejo?.estado).toBe('anulado');
    // el número anterior no se puede reutilizar
    await emitir(id, cuerpoGuia({ numero: base })).expect(409);
  });

  it('anula con motivo y la reemplaza; registra la guía firmada (solo el archivo propio del módulo) y ya no se puede anular', async () => {
    const id = await pedidoConReportes();
    const g = (await emitir(id).expect(201)).body;
    // sin anular no se puede "reemplazar"
    await emitir(id, cuerpoGuia({ reemplazaAId: g.id })).expect(400);
    await http().post(`/api/comercial/guias/${g.id}/anular`).set(fact()).send({}).expect(400);
    const anulada = await http()
      .post(`/api/comercial/guias/${g.id}/anular`)
      .set(fact())
      .send({ motivo: 'ítem equivocado' })
      .expect(201);
    expect(anulada.body).toMatchObject({
      estado: 'anulada',
      anulacion: { motivo: 'ítem equivocado' },
    });
    await http()
      .post(`/api/comercial/guias/${g.id}/anular`)
      .set(fact())
      .send({ motivo: 'otra vez' })
      .expect(409);
    // ya no cuenta como guía registrada
    const av = (
      await http()
        .get(`/api/comercial/pedidos/${id}/documentos-operativos/avance`)
        .set(fact())
        .expect(200)
    ).body;
    expect(av.guiaRegistrada).toBe(false);
    const nueva = (await emitir(id, cuerpoGuia({ reemplazaAId: g.id })).expect(201)).body;
    expect(nueva.reemplazaAId).toBe(g.id);

    const url = `/api/comercial/guias/${nueva.id}/firmada`;
    await http().post(url).set(fact()).send({ archivoId: uuidv7() }).expect(400);
    await http().post(url).set(fact()).send({ archivoId: ARCHIVO_AJENO.id }).expect(400);
    await http().post(url).set(fact()).send({ archivoId: ARCHIVO_OTRO.id }).expect(400);
    await http().post(url).set(soloVer()).send({ archivoId: ARCHIVO_OK.id }).expect(403);
    const firmada = await http()
      .post(url)
      .set(fact())
      .send({ archivoId: ARCHIVO_OK.id })
      .expect(201);
    expect(firmada.body.firmada).toMatchObject({
      archivoId: ARCHIVO_OK.id,
      archivoNombre: 'guia firmada.pdf',
    });
    // firmada: ni se anula ni se cambia el número
    await http()
      .post(`/api/comercial/guias/${nueva.id}/anular`)
      .set(fact())
      .send({ motivo: 'tarde' })
      .expect(409);
    await http()
      .post(`/api/comercial/guias/${nueva.id}/reasignar-numero`)
      .set(fact())
      .send({ numero: 8_900_000, motivo: 'tarde' })
      .expect(409);
  });

  it('valida la firma electrónica del PDF firmado en segundo plano, la guarda normalizada y se puede repetir; si el servicio no responde la guía queda registrada', async () => {
    const id = await pedidoConReportes();
    const g = (await emitir(id).expect(201)).body;
    // sin archivo firmado no hay qué validar
    await http()
      .post(`/api/comercial/guias/${g.id}/verificar-firma-electronica`)
      .set(fact())
      .expect(409);
    const firmada = await http()
      .post(`/api/comercial/guias/${g.id}/firmada`)
      .set(fact())
      .send({ archivoId: ARCHIVO_OK.id })
      .expect(201);
    expect(firmada.body.firmada).not.toBeNull();
    const fe = await esperarElectronica(g.id);
    expect(fe).toMatchObject({
      estado: 'firmantes_no_verificados',
      resumen: '1 de 1 firmantes no verificados',
    });
    expect(fe.firmas).toHaveLength(1);
    expect(fe.firmas[0]).toMatchObject({
      firmanteIdentificacion: '1712345678',
      integridad: 'intacto',
      firmaValida: true,
      firmanteVerificado: false,
      origenFecha: 'declarada_por_el_firmante',
    });
    // repetir reemplaza el resultado (no duplica firmas)
    electronica.respuesta = {
      estado: 'sin_firmas_digitales',
      resumen: 'El PDF no contiene firmas digitales.',
      firmas: [],
    };
    const otra = await http()
      .post(`/api/comercial/guias/${g.id}/verificar-firma-electronica`)
      .set(fact())
      .expect(201);
    expect(otra.body.firmaElectronica).toMatchObject({
      estado: 'sin_firmas_digitales',
      firmas: [],
    });
    await http()
      .post(`/api/comercial/guias/${g.id}/verificar-firma-electronica`)
      .set(soloVer())
      .expect(403);
    // servicio caído: no cambia el último resultado ni falla
    electronica.respuesta = null;
    const caido = await http()
      .post(`/api/comercial/guias/${g.id}/verificar-firma-electronica`)
      .set(fact())
      .expect(201);
    expect(caido.body.firmaElectronica.estado).toBe('sin_firmas_digitales');
    // una guía sin servicio disponible al firmar queda registrada sin resultado
    const g2 = (await emitir(id).expect(201)).body;
    const r2 = await http()
      .post(`/api/comercial/guias/${g2.id}/firmada`)
      .set(fact())
      .send({ archivoId: ARCHIVO_OK.id })
      .expect(201);
    expect(r2.body.firmada).not.toBeNull();
    expect(r2.body.firmaElectronica).toBeNull();
    electronica.respuesta = { estado: 'verificado', resumen: 'ok', firmas: [] };
  });

  it('lee la firma manuscrita del archivo firmado (PDF o imagen) y solo valida la firma electrónica en PDF; si el servicio falla queda sin resultado', async () => {
    const id = await pedidoConReportes();
    // escaneo en imagen con firma a mano: se lee la manuscrita; no hay validación electrónica
    const g = (await emitir(id).expect(201)).body;
    expect(g.firmaManuscrita).toEqual({ verificacion: 'no_verificada', confianza: null, at: null });
    await http()
      .post(`/api/comercial/guias/${g.id}/firmada`)
      .set(fact())
      .send({ archivoId: ARCHIVO_IMG.id })
      .expect(201);
    const m = await esperarManuscrita(g.id);
    expect(m).toMatchObject({ verificacion: 'firma_detectada', confianza: 0.91 });
    const despues = (await http().get(`/api/comercial/guias/${g.id}`).set(soloVer()).expect(200))
      .body;
    expect(despues.firmaElectronica).toBeNull();
    // "volver a validar" repite la lectura con lo que responda el servicio
    manuscrita.respuesta = { resultado: 'no_detectada', confianza: 0.8, nombreCoincide: null };
    const otra = await http()
      .post(`/api/comercial/guias/${g.id}/verificar-firma-electronica`)
      .set(fact())
      .expect(201);
    expect(otra.body.firmaManuscrita).toMatchObject({
      verificacion: 'firma_no_detectada',
      confianza: 0.8,
    });
    expect(otra.body.firmaElectronica).toBeNull();
    // un PDF recibe las dos ayudas
    manuscrita.respuesta = { resultado: 'no_concluyente', confianza: 0.5, nombreCoincide: null };
    const g2 = (await emitir(id).expect(201)).body;
    await http()
      .post(`/api/comercial/guias/${g2.id}/firmada`)
      .set(fact())
      .send({ archivoId: ARCHIVO_OK.id })
      .expect(201);
    expect(await esperarManuscrita(g2.id)).toMatchObject({ verificacion: 'no_concluyente' });
    expect((await esperarElectronica(g2.id)).estado).toBeDefined();
    // servicio caído: la guía se registra y el intento queda anotado sin resultado
    manuscrita.respuesta = null;
    const g3 = (await emitir(id).expect(201)).body;
    await http()
      .post(`/api/comercial/guias/${g3.id}/firmada`)
      .set(fact())
      .send({ archivoId: ARCHIVO_IMG.id })
      .expect(201);
    expect(await esperarManuscrita(g3.id)).toMatchObject({
      verificacion: 'no_verificada',
      confianza: null,
    });
    manuscrita.respuesta = { resultado: 'firma_detectada', confianza: 0.91, nombreCoincide: null };
  });

  it('entrega la autorización del SRI de la secuencia para el formato impreso', async () => {
    const id = await pedidoConReportes();
    const g = (await emitir(id).expect(201)).body;
    expect(g.autorizacion).toEqual({
      numero: '1133274030',
      desde: '2026-02-12',
      hasta: '2027-02-12',
    });
    const lista = (
      await http().get(`/api/comercial/pedidos/${id}/guias`).set(soloVer()).expect(200)
    ).body;
    expect(lista[0].autorizacion.numero).toBe('1133274030');
  });

  it('despacho a Bodega (CM-5): Facturación lo pide con bodega, fecha e ítems; el resultado de Inventario devuelve el pedido a la prefactura', async () => {
    const id = await pedidoConReportes();
    const solicitar = (cuerpo: object, quien = fact()) =>
      http().post(`/api/comercial/pedidos/${id}/despacho/solicitar`).set(quien).send(cuerpo);
    const bodegaId = (await prisma.catBodega.findFirstOrThrow({ select: { id: true } })).id;
    const items = await prisma.pedidoItem.findMany({
      where: { pedidoId: id },
      orderBy: { orden: 'asc' },
    });
    const mat = items.find((i) => i.codigo.startsWith('MAT-'))!;
    const sup = items.find((i) => i.codigo.startsWith('SUP-'))!;
    const valido = {
      bodegaId,
      fechaRequerida: '2099-01-15',
      nota: 'Para el viernes',
      items: [{ pedidoItemId: mat.id, cantidad: 2 }],
    };
    // antes de la prefactura no se solicita
    await solicitar(valido).expect(409);
    await http().post(`/api/comercial/pedidos/${id}/prefacturas`).set(fact()).expect(201);
    // permisos: Bodega no solicita (lo resuelve en Inventario)
    await solicitar(valido, bodega()).expect(403);
    // reglas de la solicitud
    await solicitar({ ...valido, items: [] }).expect(400);
    await solicitar({ ...valido, fechaRequerida: '2020-01-01' }).expect(400);
    await solicitar({ ...valido, bodegaId: uuidv7() }).expect(400);
    await solicitar({ ...valido, items: [{ pedidoItemId: uuidv7(), cantidad: 1 }] }).expect(400);
    await solicitar({ ...valido, items: [{ pedidoItemId: sup.id, cantidad: 1 }] }).expect(400);
    await solicitar({ ...valido, items: [{ pedidoItemId: mat.id, cantidad: 4 }] }).expect(400);
    expect(await estadoDe(id)).toBe('prefactura_generada');

    await solicitar(valido).expect(201);
    expect(await estadoDe(id)).toBe('por_despachar_bodega');
    await solicitar(valido).expect(409);
    const [evento] = await prisma.$queryRaw<{ datos: { data: Record<string, unknown> } }[]>`
      SELECT datos FROM msg_comercial.outbox
       WHERE tipo = 'comercial.despacho.solicitado' AND datos->'data'->>'pedidoId' = ${id}`;
    expect(evento.datos.data).toMatchObject({
      bodegaId,
      fechaRequerida: '2099-01-15',
      nota: 'Para el viernes',
      items: [
        {
          codigo: mat.codigo,
          descripcion: 'Niple de prueba',
          cantidad: 2,
          unidadMedidaId: mat.unidadMedidaId,
          tipo: 'material',
          listaPreciosItemId: mat.listaPreciosItemId,
        },
      ],
    });

    // Bodega lo rechaza en Inventario: el pedido vuelve a la prefactura (una sola vez aunque el evento se repita)
    const consumidor = app.get(DespachoResultadoConsumer);
    const resultado = (type: string, data: Record<string, unknown>) =>
      ({
        id: uuidv7(),
        type,
        version: 1,
        occurredAt: new Date().toISOString(),
        source: 'operaciones',
        subject: { type: 'inventario_despacho', id: uuidv7() },
        data: { pedidoId: id, numero: 7, ...data },
        actor: { userId: ACTOR, role: 'bodeguero' },
      }) as EventEnvelope;
    const rechazo = resultado('operaciones.inventario.despacho.rechazado', { motivo: 'Sin stock' });
    await consumidor.consumir(rechazo);
    await consumidor.consumir(rechazo);
    expect(await estadoDe(id)).toBe('prefactura_generada');
    const [paso] = await prisma.procesoHistorial.findMany({
      where: { entidadId: id, estadoAnterior: 'por_despachar_bodega' },
      orderBy: { createdAt: 'desc' },
      take: 1,
    });
    expect(paso.motivo).toBe('despacho 7 rechazado: Sin stock');
    // un resultado que llega cuando el pedido ya no espera el despacho se omite sin fallar
    await consumidor.consumir(resultado('operaciones.inventario.despacho.realizado', {}));
    expect(await estadoDe(id)).toBe('prefactura_generada');
    // otra solicitud, ahora despachada
    await solicitar(valido).expect(201);
    await consumidor.consumir(
      resultado('operaciones.inventario.despacho.realizado', { numero: 8 }),
    );
    expect(await estadoDe(id)).toBe('prefactura_generada');
  });
});
