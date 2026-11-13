/**
 * Integración real del expediente del pedido (índice de documentos y versiones firmadas): Postgres (PgBouncer, app_comercial); Operaciones,
 * QHSE, archivos y personas simulados con puertos falsos. Crea su propio cliente y pedidos (`it_<n>`) y los elimina al final.
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
import { DirectorioPort } from './directorio/directorio.port';
import {
  OperacionesPort,
  type DocumentoFcrRef,
  type DocumentoTicketPumpingRef,
  type GerenciamientoViajeRef,
  type InspeccionVehiculoRef,
  type OrdenMantenimientoRef,
  type ReporteUnidadRef,
} from './directorio/operaciones.port';
import { QhsePort, type DocumentoQhseRef } from './directorio/qhse.port';
import { ExpedienteService } from './expediente/expediente.service';
import type { Expediente } from './expediente/expediente.types';
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
const BLOQUE_IT = { id: uuidv7(), nombre: `Bloque EXP ${n}` };
const CAMPO_IT = { id: uuidv7(), nombre: `Campo EXP ${n}` };
const POZO_IT = {
  id: uuidv7(),
  nombre: `POZO EXP ${n}`,
  campoId: CAMPO_IT.id,
  bloqueId: BLOQUE_IT.id,
};

const archivo = (nombre: string, modulo: string) => ({
  id: uuidv7(),
  modulo,
  nombre,
  mimeType: 'application/pdf',
  tamanoBytes: 100,
  subidoPor: ACTOR,
});
const A_MONITOREO = archivo('monitoreo.pdf', 'ticket_monitoreo_documento');
const A_MEZCLA = archivo('mezcla.pdf', 'ticket_mezcla_documento');
const A_QHSE_ART = archivo('art.pdf', 'qhse_documento_pedido');
const A_QHSE_PT = archivo('pt.pdf', 'qhse_documento_pedido');
const A_FCR = archivo('qaqc.pdf', 'ticket_fcr_documento');
const A_ADJUNTO = archivo('adjunto.pdf', 'pedido_documento');
/** Archivos «firmados» que se van cargando (uno por carga: un archivo no se registra dos veces en el pedido). */
const FIRMADOS = Array.from({ length: 14 }, (_, i) =>
  archivo(`firmado ${i + 1}.pdf`, 'documento_respaldo_firmado'),
);
const TODOS_LOS_ARCHIVOS = [
  A_MONITOREO,
  A_MEZCLA,
  A_QHSE_ART,
  A_QHSE_PT,
  A_FCR,
  A_ADJUNTO,
  ...FIRMADOS,
];

const MAESTROS: MaestrosDePrueba = {
  usuarios: [{ id: ACTOR, nombre: 'Fabiola Facturación', rol: 'facturacion' }],
  clientes: [{ id: CLIENTE, nombre: `Cliente EXP ${n}`, ruc: `93${String(n).slice(-11)}` }],
  campos: [CAMPO_IT],
  bloques: [BLOQUE_IT],
  pozos: [POZO_IT],
  archivos: TODOS_LOS_ARCHIVOS,
};
const P = Permission;

run('expediente del pedido (base de datos real)', () => {
  jest.setTimeout(90000);
  let app: INestApplication;
  let prisma: PrismaService;
  let servicio: ExpedienteService;
  const admin = new Pool({ connectionString: MIGRATOR_DB, max: 2 });
  const http = () => request(app.getHttpServer());
  const signer = new JwtService({
    privateKey,
    signOptions: { algorithm: 'RS256', issuer: 'dynadrill-plataforma', expiresIn: 600 },
  });
  const token = (permissions: string[]) =>
    signer.sign({
      sub: ACTOR,
      email: 'it@test.local',
      roleId: 'r',
      roleCode: 'facturacion',
      permissions,
    });
  const bearer = (permissions: string[]) => ({ Authorization: `Bearer ${token(permissions)}` });
  const TOKEN_FACT = token([P.DOCUMENTOS_OPERATIVOS_VER, P.PREFACTURAS_FIRMAR]);
  const fact = () => ({ Authorization: `Bearer ${TOKEN_FACT}` });
  const pedidos: string[] = [];

  // ---- lo que responden Operaciones y QHSE (puertos falsos) -------------------------------------------
  const remoto = {
    pumpingDocs: new Map<string, DocumentoTicketPumpingRef[]>(),
    fcrDocs: new Map<string, DocumentoFcrRef[]>(),
    reportesUnidad: new Map<string, ReporteUnidadRef[]>(),
    inspecciones: new Map<string, InspeccionVehiculoRef[]>(),
    viajes: new Map<string, GerenciamientoViajeRef[]>(),
    ordenes: new Map<string, OrdenMantenimientoRef[]>(),
    qhse: new Map<string, DocumentoQhseRef[]>(),
    /** Métodos que fallan con 503 o que no responden nunca. */
    caidos: new Set<string>(),
    colgados: new Set<string>(),
    llamadas: [] as Array<{ metodo: string; token: string }>,
  };
  const consulta =
    <T>(metodo: string, datos: (id: string) => T) =>
    async (id: string, tokenRecibido: string): Promise<T> => {
      remoto.llamadas.push({ metodo, token: tokenRecibido });
      if (remoto.colgados.has(metodo)) return new Promise<T>(() => undefined);
      if (remoto.caidos.has(metodo)) {
        throw new ServiceUnavailableException(`${metodo} no responde`);
      }
      return datos(id);
    };
  const operacionesFalsa = {
    documentosDeTicketPumping: consulta(
      'pumping.documentos',
      (id) => remoto.pumpingDocs.get(id) ?? null,
    ),
    documentosDeTicketFcr: consulta('fcr.documentos', (id) => remoto.fcrDocs.get(id) ?? []),
    reportesDeUnidadDeTicket: consulta(
      'pumping.reportesUnidad',
      (id) => remoto.reportesUnidad.get(id) ?? [],
    ),
    inspeccionesDeTicket: consulta('flota.inspecciones', (id) => remoto.inspecciones.get(id) ?? []),
    viajesDeTicket: consulta('flota.viajes', (id) => remoto.viajes.get(id) ?? []),
    ordenesMantenimientoDelServicio: consulta(
      'mantenimiento.ordenes',
      (id) => remoto.ordenes.get(id) ?? [],
    ),
  };
  const qhseFalso = {
    documentosDelPedido: consulta('qhse.documentos', (id) => remoto.qhse.get(id) ?? []),
  };
  const directorioFalso = {
    archivo: async (i: string) => TODOS_LOS_ARCHIVOS.find((a) => a.id === i) ?? null,
    verificarFirma: async () => null,
  };

  // ---- datos de prueba ---------------------------------------------------------------------------------
  interface Escenario {
    pedidoId: string;
    ticketId: string;
    jobDia2: string;
    herramientas: string;
    prefactura: string;
    adjunto: string;
    orden: OrdenMantenimientoRef;
    reporteUnidad: ReporteUnidadRef;
    pt: DocumentoQhseRef;
    art: DocumentoQhseRef;
    monitoreo: DocumentoTicketPumpingRef;
    mezcla: DocumentoTicketPumpingRef;
    inspeccion: InspeccionVehiculoRef;
    viaje: GerenciamientoViajeRef;
  }

  const crearPedido = async (linea: 'pumping' | 'fcr', origen: 'pumping' | 'fcr') => {
    const l = await prisma.servicioLinea.findUniqueOrThrow({ where: { codigo: linea } });
    const t = await prisma.tipoOt.findUniqueOrThrow({ where: { codigo: 'servicio' } });
    const pedidoId = uuidv7();
    const ticketId = uuidv7();
    const ticketNumero = 1_000_000_000 + (n % 100_000_000) + pedidos.length;
    await prisma.pedido.create({
      data: {
        id: pedidoId,
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
        numeroContrato: 'CT-EXP',
        fechaInicioServicio: new Date('2026-11-01T00:00:00Z'),
        fechaFinServicio: new Date('2026-11-03T00:00:00Z'),
        agenteComercialId: ACTOR,
        tecnicoHseId: ACTOR,
        ticketNumero,
      },
    });
    await prisma.pedidoTicketOperativo.create({
      data: { pedidoId, origen, ticketId, pasoCodigo: 'ejecucion_operativa' },
    });
    pedidos.push(pedidoId);
    return { pedidoId, ticketId, ticketNumero };
  };
  const operativo = async (
    pedidoId: string,
    d: { tipo: 'reporte_job' | 'reporte_herramientas'; dia?: string; quitado?: boolean },
  ) => {
    const id = uuidv7();
    await prisma.documentoOperativo.create({
      data: {
        id,
        pedidoId,
        tipo: d.tipo,
        origen: 'pumping',
        fecha: d.dia ? new Date(`${d.dia}T00:00:00Z`) : null,
        recibidoPor: ACTOR,
        ...(d.quitado ? { corregidoAt: new Date(), corregidoPor: ACTOR } : {}),
      },
    });
    return id;
  };

  /** Un pedido de Pumping con documentos en todos los grupos (y algunos que NO deben aparecer: anulados, rechazados, quitados). */
  const escenarioPumping = async (): Promise<Escenario> => {
    const { pedidoId, ticketId } = await crearPedido('pumping', 'pumping');
    const job1 = await operativo(pedidoId, { tipo: 'reporte_job', dia: '2026-11-01' });
    const jobDia2 = await operativo(pedidoId, { tipo: 'reporte_job', dia: '2026-11-02' });
    // el día 3 lo quitó Facturación: ya no es un documento del expediente
    await operativo(pedidoId, { tipo: 'reporte_job', dia: '2026-11-03', quitado: true });
    const herramientas = await operativo(pedidoId, { tipo: 'reporte_herramientas' });
    expect(job1).toBeTruthy();

    const costo = {
      subtotalServicios: 0,
      subtotalMateriales: 0,
      subtotal: 0,
      iva: 0,
      netoCobrar: 0,
    };
    const base = {
      ...costo,
      pedidoId,
      retencionIr: 0,
      retencionIva: 0,
      ivaPct: 15,
      retencionIrPct: 0,
      retencionIvaPct: 0,
      generadaPor: ACTOR,
    };
    const prefactura = uuidv7();
    await prisma.prefactura.create({
      data: {
        ...base,
        id: uuidv7(),
        version: 1,
        estado: 'rechazada',
        rechazadaAt: new Date(),
        rechazoMotivo: 'Faltan soportes',
        rechazoDevueltoA: 'operaciones',
      },
    });
    await prisma.prefactura.create({ data: { ...base, id: prefactura, version: 2 } });
    await emitirGuiaDePrueba(admin, pedidoId, ACTOR);
    const adjunto = uuidv7();
    await prisma.pedidoDocumento.create({
      data: { id: adjunto, pedidoId, archivoId: A_ADJUNTO.id, descripcion: 'Carta del cliente' },
    });

    const monitoreo = {
      id: uuidv7(),
      tipo: 'monitoreo' as const,
      fecha: '2026-11-02',
      archivoId: A_MONITOREO.id,
    };
    const mezcla = {
      id: uuidv7(),
      tipo: 'mezcla_quimica' as const,
      fecha: null,
      archivoId: A_MEZCLA.id,
    };
    remoto.pumpingDocs.set(ticketId, [monitoreo, mezcla]);
    const reporteUnidad = { id: uuidv7(), fecha: '2026-11-02', unidad: 'PXB-123' };
    remoto.reportesUnidad.set(ticketId, [reporteUnidad]);
    const inspeccion = {
      id: uuidv7(),
      fecha: '2026-11-02T14:30:00.000Z',
      unidad: 'PXB-123',
      momento: 'salida',
      anulada: false,
    };
    remoto.inspecciones.set(ticketId, [
      inspeccion,
      { ...inspeccion, id: uuidv7(), momento: 'llegada', anulada: true },
    ]);
    const viaje = {
      id: uuidv7(),
      codigo: 'GV-0001',
      tipo: 'salida',
      fecha: '2026-11-01',
      unidad: 'PXB-123',
      estado: 'autorizado',
    };
    remoto.viajes.set(ticketId, [viaje, { ...viaje, id: uuidv7(), estado: 'rechazado' }]);
    const orden = {
      id: uuidv7(),
      codigo: 'OM-0012',
      unidad: 'PXB-123',
      tiposSuborden: ['mecanico', 'operativo'],
      creadaAt: '2026-11-02T15:00:00.000Z',
    };
    remoto.ordenes.set(ticketId, [orden]);
    const art = {
      id: uuidv7(),
      tipo: 'art',
      archivoId: A_QHSE_ART.id,
      referencia: null,
      fecha: '2026-11-01',
    };
    const pt = {
      id: uuidv7(),
      tipo: 'pt',
      archivoId: A_QHSE_PT.id,
      referencia: null,
      fecha: '2026-11-02',
    };
    remoto.qhse.set(pedidoId, [art, pt]);
    return {
      pedidoId,
      ticketId,
      jobDia2,
      herramientas,
      prefactura,
      adjunto,
      orden,
      reporteUnidad,
      pt,
      art,
      monitoreo,
      mezcla,
      inspeccion,
      viaje,
    };
  };

  const indice = async (pedidoId: string) =>
    (await http().get(`/api/comercial/pedidos/${pedidoId}/expediente`).set(fact()).expect(200))
      .body as Expediente;
  const grupo = (e: Expediente, origen: string) => e.grupos.find((g) => g.origen === origen)!;
  const tipos = (e: Expediente, origen: string) =>
    grupo(e, origen)
      .documentos.map((d) => d.tipo)
      .sort();

  beforeAll(async () => {
    await sembrarMaestros(admin, MAESTROS);
    Object.assign(process.env, {
      SERVICE_NAME: 'comercial-exp-test',
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
        CommonModule.forRoot({ serviceName: 'comercial-exp-test' }),
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
      .useValue(operacionesFalsa)
      .overrideProvider(QhsePort)
      .useValue(qhseFalso)
      .compile();
    app = mod.createNestApplication();
    configureApp(app, { corsOrigins: ['http://localhost:4200'] });
    sinSuscripciones();
    await app.init();
    prisma = app.get(PrismaService);
    servicio = app.get(ExpedienteService);
  });

  beforeEach(() => {
    remoto.caidos.clear();
    remoto.colgados.clear();
    remoto.llamadas.length = 0;
    servicio.limiteMs = 8_000;
  });

  afterAll(async () => {
    if (pedidos.length) {
      await quitarGuiasDePrueba(admin, pedidos);
      for (const tabla of [
        'documento_respaldo_firmado',
        'pedido_ticket_operativo',
        'documento_operativo',
        'pedido_documento',
        'prefactura',
        'proceso_historial',
      ]) {
        const columna = tabla === 'proceso_historial' ? 'entidad_id' : 'pedido_id';
        await admin.query(`DELETE FROM comercial.${tabla} WHERE ${columna} = ANY($1::uuid[])`, [
          pedidos,
        ]);
      }
      await admin.query('DELETE FROM comercial.pedido WHERE id = ANY($1::uuid[])', [pedidos]);
    }
    await quitarMaestros(admin, MAESTROS);
    await admin.end();
    await app.close();
  });

  describe('índice GET comercial/pedidos/:pedidoId/expediente', () => {
    it('un pedido de Pumping trae todos los grupos con solo lo vigente y «pertenece» legible', async () => {
      const x = await escenarioPumping();
      const e = await indice(x.pedidoId);

      expect(e.pedido).toMatchObject({
        id: x.pedidoId,
        fechaInicioServicio: '2026-11-01',
        fechaFinServicio: '2026-11-03',
      });
      expect(e.grupos.map((g) => g.origen)).toEqual([
        'facturacion',
        'operaciones',
        'qhse',
        'mantenimiento',
        'flota_inspeccion',
        'flota_viaje',
        'adjuntos',
      ]);
      expect(e.grupos.every((g) => g.disponible && g.motivoNoDisponible === null)).toBe(true);
      expect(e.grupos.map((g) => g.etiqueta)).toEqual([
        'Facturación',
        'Operaciones',
        'QHSE',
        'Mantenimiento',
        'Inspecciones de unidades',
        'Gerenciamiento de viaje',
        'Adjuntos',
      ]);

      // Facturación: la prefactura vigente (no la rechazada) y la guía emitida
      expect(tipos(e, 'facturacion')).toEqual(['guia_remision', 'prefactura']);
      const pref = grupo(e, 'facturacion').documentos.find((d) => d.tipo === 'prefactura')!;
      expect(pref).toMatchObject({
        clave: `prefactura:${x.prefactura}`,
        fuente: 'formato',
        archivo: null,
        formato: { codigo: 'prefactura', refId: x.prefactura },
        pertenece: 'Prefactura versión 2',
        admiteFirmado: true,
        firmado: null,
      });

      // Operaciones: dos días de Reporte Job (el quitado no), herramientas, monitoreo, mezcla y reporte de unidad
      expect(tipos(e, 'operaciones')).toEqual([
        'mezcla_quimica',
        'monitoreo',
        'reporte_herramientas',
        'reporte_job',
        'reporte_job',
        'reporte_unidad',
      ]);
      const ops = grupo(e, 'operaciones').documentos;
      expect(ops.find((d) => d.clave === `reporte_job:${x.jobDia2}`)).toMatchObject({
        pertenece: 'Día 2 · 02/11/2026',
        fecha: '2026-11-02',
        fuente: 'formato',
      });
      expect(ops.find((d) => d.tipo === 'reporte_herramientas')?.pertenece).toBe(
        'Todo el servicio',
      );
      expect(ops.find((d) => d.tipo === 'monitoreo')).toMatchObject({
        pertenece: 'Día 2 · 02/11/2026',
        fuente: 'archivo',
        archivo: { id: A_MONITOREO.id, nombre: 'monitoreo.pdf', mime: 'application/pdf' },
        formato: null,
      });
      expect(ops.find((d) => d.tipo === 'mezcla_quimica')?.pertenece).toBe('Todo el servicio');
      expect(ops.find((d) => d.tipo === 'reporte_unidad')?.pertenece).toBe(
        'Unidad PXB-123 · Día 2 · 02/11/2026',
      );

      // QHSE
      expect(tipos(e, 'qhse')).toEqual(['qhse_art', 'qhse_pt']);
      expect(grupo(e, 'qhse').documentos.find((d) => d.tipo === 'qhse_pt')).toMatchObject({
        pertenece: 'Día 2 · 02/11/2026',
        archivo: { nombre: 'pt.pdf' },
      });

      // Mantenimiento: orden general, operativa (hay sub-orden operativa) e informe, de la unidad y la orden
      expect(tipos(e, 'mantenimiento')).toEqual([
        'informe_mantenimiento',
        'orden_mantenimiento_general',
        'orden_mantenimiento_operativa',
      ]);
      expect(
        grupo(e, 'mantenimiento').documentos.every(
          (d) =>
            d.pertenece === 'Unidad PXB-123 · Orden OM-0012' && d.formato?.refId === x.orden.id,
        ),
      ).toBe(true);

      // Flota: la inspección anulada y el viaje rechazado no aparecen
      expect(grupo(e, 'flota_inspeccion').documentos).toHaveLength(1);
      expect(grupo(e, 'flota_inspeccion').documentos[0]).toMatchObject({
        tipo: 'inspeccion_vehiculo',
        pertenece: 'Unidad PXB-123 · Salida · 02/11/2026',
        fecha: '2026-11-02',
      });
      expect(grupo(e, 'flota_viaje').documentos).toHaveLength(1);
      expect(grupo(e, 'flota_viaje').documentos[0]).toMatchObject({
        tipo: 'gerenciamiento_viaje',
        pertenece: 'Unidad PXB-123 · Salida · 01/11/2026',
      });

      // adjuntos
      expect(grupo(e, 'adjuntos').documentos[0]).toMatchObject({
        clave: `adjunto:${x.adjunto}`,
        titulo: 'Carta del cliente',
        fuente: 'archivo',
        archivo: { id: A_ADJUNTO.id, nombre: 'adjunto.pdf' },
      });

      // las claves son únicas en todo el pedido y todos los documentos admiten firmado
      const todos = e.grupos.flatMap((g) => g.documentos);
      expect(new Set(todos.map((d) => d.clave)).size).toBe(todos.length);
      expect(todos.every((d) => d.admiteFirmado)).toBe(true);
    });

    it('reenvía el token de quien pide a Operaciones y a QHSE', async () => {
      const x = await escenarioPumping();
      await indice(x.pedidoId);
      expect(remoto.llamadas.length).toBeGreaterThanOrEqual(6);
      expect(remoto.llamadas.every((c) => c.token === TOKEN_FACT)).toBe(true);
    });

    it('un pedido de FCR no trae los grupos de Flota ni de Mantenimiento y sus documentos son los de FCR', async () => {
      const { pedidoId, ticketId, ticketNumero } = await crearPedido('fcr', 'fcr');
      await operativo(pedidoId, { tipo: 'reporte_job', dia: '2026-11-01' });
      await operativo(pedidoId, { tipo: 'reporte_herramientas' });
      const fcrDocId = uuidv7();
      remoto.fcrDocs.set(ticketId, [{ id: fcrDocId, campo: 'registro_qaqc', archivoId: A_FCR.id }]);
      remoto.qhse.set(pedidoId, []);
      const e = await indice(pedidoId);
      expect(e.grupos.map((g) => g.origen)).toEqual([
        'facturacion',
        'operaciones',
        'qhse',
        'adjuntos',
      ]);
      expect(tipos(e, 'operaciones')).toEqual([
        'fcr_registro_qaqc',
        'reporte_herramientas',
        'reporte_job',
      ]);
      expect(
        grupo(e, 'operaciones').documentos.find((d) => d.tipo === 'fcr_registro_qaqc'),
      ).toMatchObject({
        clave: `fcr_registro_qaqc:${fcrDocId}`,
        pertenece: `Ticket ${ticketNumero}`,
        titulo: 'Registro QA/QC',
        archivo: { nombre: 'qaqc.pdf' },
      });
      // FCR no consulta a Pumping, a Flota ni a Mantenimiento
      expect(remoto.llamadas.map((c) => c.metodo).sort()).toEqual([
        'fcr.documentos',
        'qhse.documentos',
      ]);
    });

    it('un módulo caído deja su grupo como no disponible (con el motivo) y el resto del índice sale completo', async () => {
      const x = await escenarioPumping();
      remoto.caidos.add('flota.inspecciones');
      const e = await indice(x.pedidoId);
      const flota = grupo(e, 'flota_inspeccion');
      expect(flota).toMatchObject({ disponible: false, documentos: [] });
      expect(flota.motivoNoDisponible).toContain('flota.inspecciones no responde');
      expect(grupo(e, 'mantenimiento').disponible).toBe(true);
      expect(grupo(e, 'qhse').documentos).toHaveLength(2);
      expect(grupo(e, 'facturacion').documentos).toHaveLength(2);

      // si falla solo una de las dos consultas de Operaciones, el grupo avisa pero conserva lo que sí se leyó
      remoto.caidos.clear();
      remoto.caidos.add('pumping.reportesUnidad');
      const parcial = grupo(await indice(x.pedidoId), 'operaciones');
      expect(parcial.disponible).toBe(false);
      expect(parcial.motivoNoDisponible).toContain('pumping.reportesUnidad no responde');
      expect(parcial.documentos.map((d) => d.tipo)).toContain('monitoreo');
      expect(parcial.documentos.map((d) => d.tipo)).toContain('reporte_job');
      expect(parcial.documentos.map((d) => d.tipo)).not.toContain('reporte_unidad');
    });

    it('un módulo que no responde a tiempo no retrasa el índice: su grupo sale no disponible', async () => {
      const x = await escenarioPumping();
      servicio.limiteMs = 100;
      remoto.colgados.add('qhse.documentos');
      const t0 = Date.now();
      const e = await indice(x.pedidoId);
      expect(Date.now() - t0).toBeLessThan(5_000);
      expect(grupo(e, 'qhse')).toMatchObject({
        disponible: false,
        motivoNoDisponible: 'No respondió a tiempo',
        documentos: [],
      });
      expect(grupo(e, 'operaciones').disponible).toBe(true);
    });

    it('exige el permiso de ver documentos operativos y el pedido debe existir', async () => {
      const x = await escenarioPumping();
      await http()
        .get(`/api/comercial/pedidos/${x.pedidoId}/expediente`)
        .set(bearer([P.PEDIDOS_VER]))
        .expect(403);
      await http().get(`/api/comercial/pedidos/${uuidv7()}/expediente`).set(fact()).expect(404);
    });
  });

  describe('versión firmada de cualquier documento del expediente', () => {
    let k = 0;
    const siguiente = () => FIRMADOS[k++ % FIRMADOS.length];
    const cargar = (pedidoId: string, cuerpo: object) =>
      http()
        .post(`/api/comercial/pedidos/${pedidoId}/documentos-firmados`)
        .set(fact())
        .send(cuerpo);
    const firmado = (e: Expediente, clave: string) =>
      e.grupos.flatMap((g) => g.documentos).find((d) => d.clave === clave)?.firmado ?? null;

    it('formatos propios (Reporte Job, prefactura): se firman, aparecen en el índice y una versión nueva reemplaza a la anterior', async () => {
      const x = await escenarioPumping();
      const a = siguiente();
      const b = siguiente();
      const job = {
        tipo: 'reporte_job',
        documentoTicketId: x.jobDia2,
        fecha: '2026-11-02',
        archivoId: a.id,
      };
      await cargar(x.pedidoId, job).expect(201);
      let e = await indice(x.pedidoId);
      expect(firmado(e, `reporte_job:${x.jobDia2}`)).toMatchObject({
        archivoId: a.id,
        nombre: a.nombre,
        subidoPor: 'Fabiola Facturación',
      });
      // el día se guardó con el del documento
      const fila = await prisma.documentoRespaldoFirmado.findFirstOrThrow({
        where: { pedidoId: x.pedidoId, archivoId: a.id },
      });
      expect(fila.fecha?.toISOString().slice(0, 10)).toBe('2026-11-02');

      await cargar(x.pedidoId, { ...job, archivoId: b.id }).expect(201);
      e = await indice(x.pedidoId);
      expect(firmado(e, `reporte_job:${x.jobDia2}`)?.archivoId).toBe(b.id);
      expect(
        await prisma.documentoRespaldoFirmado.count({
          where: { pedidoId: x.pedidoId, tipo: 'reporte_job' },
        }),
      ).toBe(2);
      expect(
        await prisma.documentoRespaldoFirmado.count({
          where: { pedidoId: x.pedidoId, tipo: 'reporte_job', reemplazadoPorId: null },
        }),
      ).toBe(1);

      await cargar(x.pedidoId, {
        tipo: 'prefactura',
        documentoTicketId: x.prefactura,
        archivoId: siguiente().id,
      }).expect(201);
      expect(firmado(await indice(x.pedidoId), `prefactura:${x.prefactura}`)).not.toBeNull();
    });

    it('la versión vigente se busca también por tipo: dos tipos con el mismo id de origen no se reemplazan', async () => {
      const x = await escenarioPumping();
      for (const tipo of ['orden_mantenimiento_general', 'informe_mantenimiento']) {
        await cargar(x.pedidoId, {
          tipo,
          documentoTicketId: x.orden.id,
          archivoId: siguiente().id,
        }).expect(201);
      }
      expect(
        await prisma.documentoRespaldoFirmado.count({
          where: { pedidoId: x.pedidoId, documentoTicketId: x.orden.id, reemplazadoPorId: null },
        }),
      ).toBe(2);
      const e = await indice(x.pedidoId);
      expect(firmado(e, `orden_mantenimiento_general:${x.orden.id}`)).not.toBeNull();
      expect(firmado(e, `informe_mantenimiento:${x.orden.id}`)).not.toBeNull();
      expect(firmado(e, `orden_mantenimiento_operativa:${x.orden.id}`)).toBeNull();
    });

    it('documentos de otros módulos (QHSE, Operaciones, Flota) y adjuntos se validan contra el índice', async () => {
      const x = await escenarioPumping();
      const casos: Array<[string, string]> = [
        ['qhse_art', x.art.id],
        ['qhse_pt', x.pt.id],
        ['reporte_unidad', x.reporteUnidad.id],
        ['inspeccion_vehiculo', x.inspeccion.id],
        ['gerenciamiento_viaje', x.viaje.id],
        ['orden_mantenimiento_operativa', x.orden.id],
        ['adjunto', x.adjunto],
        ['reporte_herramientas', x.herramientas],
      ];
      for (const [tipo, id] of casos) {
        await cargar(x.pedidoId, { tipo, documentoTicketId: id, archivoId: siguiente().id }).expect(
          201,
        );
      }
      const e = await indice(x.pedidoId);
      for (const [tipo, id] of casos) expect(firmado(e, `${tipo}:${id}`)).not.toBeNull();
      // el monitoreo y la mezcla siguen validándose contra el ticket de Pumping
      await cargar(x.pedidoId, {
        tipo: 'monitoreo',
        documentoTicketId: x.monitoreo.id,
        fecha: '2026-11-02',
        archivoId: siguiente().id,
      }).expect(201);
      await cargar(x.pedidoId, {
        tipo: 'mezcla_quimica',
        documentoTicketId: x.mezcla.id,
        archivoId: siguiente().id,
      }).expect(201);
      const lista = (
        await http()
          .get(`/api/comercial/pedidos/${x.pedidoId}/documentos-firmados`)
          .set(fact())
          .expect(200)
      ).body as Array<{ tipo: string }>;
      expect(lista).toHaveLength(casos.length + 2);
    });

    it('rechaza un documento que no está en el índice, de otro tipo, de otro día o de un módulo que no respondió', async () => {
      const x = await escenarioPumping();
      const rechaza = async (c: object, mensaje: RegExp, estado = 400) => {
        const r = await cargar(x.pedidoId, c).expect(estado);
        expect(String(r.body.detail ?? r.body.message)).toMatch(mensaje);
      };
      const base = { archivoId: siguiente().id };
      // un id que no existe, o de otro pedido
      await rechaza(
        { ...base, tipo: 'qhse_art', documentoTicketId: uuidv7() },
        /no pertenece al expediente/,
      );
      // el id existe pero con otro tipo (el ART no es una prueba de trabajo)
      await rechaza(
        { ...base, tipo: 'qhse_pt', documentoTicketId: x.art.id },
        /no pertenece al expediente/,
      );
      // el día debe ser el del documento
      await rechaza(
        { ...base, tipo: 'reporte_job', documentoTicketId: x.jobDia2, fecha: '2026-11-01' },
        /es del día 2026-11-02, no del 2026-11-01/,
      );
      // un documento de FCR no existe en un pedido de Pumping
      await rechaza(
        { ...base, tipo: 'fcr_registro_qaqc', documentoTicketId: uuidv7() },
        /no pertenece al expediente/,
      );
      // QHSE no responde: no se puede comprobar y no se acepta a ciegas
      remoto.caidos.add('qhse.documentos');
      await rechaza(
        { ...base, tipo: 'qhse_art', documentoTicketId: x.art.id },
        /no respondió: QHSE/,
        503,
      );
      remoto.caidos.clear();
      // permisos y archivo ajeno
      await http()
        .post(`/api/comercial/pedidos/${x.pedidoId}/documentos-firmados`)
        .set(bearer([P.DOCUMENTOS_OPERATIVOS_VER]))
        .send({ ...base, tipo: 'qhse_art', documentoTicketId: x.art.id })
        .expect(403);
      await rechaza(
        { tipo: 'qhse_art', documentoTicketId: x.art.id, archivoId: A_ADJUNTO.id },
        /no se subió como documento firmado/,
      );
      expect(await prisma.documentoRespaldoFirmado.count({ where: { pedidoId: x.pedidoId } })).toBe(
        0,
      );
    });

    it('en un pedido de FCR se firma un documento de FCR; el monitoreo (de Pumping) no aplica', async () => {
      const { pedidoId, ticketId } = await crearPedido('fcr', 'fcr');
      const fcrDocId = uuidv7();
      remoto.fcrDocs.set(ticketId, [{ id: fcrDocId, campo: 'registro_qaqc', archivoId: A_FCR.id }]);
      remoto.qhse.set(pedidoId, []);
      await cargar(pedidoId, {
        tipo: 'fcr_registro_qaqc',
        documentoTicketId: fcrDocId,
        archivoId: siguiente().id,
      }).expect(201);
      expect(firmado(await indice(pedidoId), `fcr_registro_qaqc:${fcrDocId}`)).not.toBeNull();
      await cargar(pedidoId, {
        tipo: 'monitoreo',
        documentoTicketId: uuidv7(),
        fecha: '2026-11-01',
        archivoId: siguiente().id,
      }).expect(409);
    });
  });
});
