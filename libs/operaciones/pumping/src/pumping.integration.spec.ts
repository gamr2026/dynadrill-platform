/**
 * Integración real de Pumping: Postgres (PgBouncer, app_operaciones). El receptor de pedidos abiertos se prueba llamando
 * a `consumir` con un evento como el que publica `comercial` (sin RabbitMQ). Limpia lo que crea.
 *   RUN_INTEGRATION=1 npx nx test pumping
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
import { EventBus, MessagingModule, type EventEnvelope } from '@dyn/messaging';
import { uuidv7 } from '@dyn/utils';
import { DespachosConsumer } from '@dyn/inventario';
import { DiaCorregidoConsumer } from './consumers/dia-corregido.consumer';
import { ResultadoCambioItemsConsumer } from './consumers/resultado-cambio-items.consumer';
import { PedidosAbiertosConsumer } from './consumers/pedidos-abiertos.consumer';
import { RequisitosExternosConsumer } from './consumers/requisitos-externos.consumer';
import { PumpingModule } from './pumping.module';
import { PrismaService } from './prisma/prisma.service';
import { quitarMaestros, sembrarMaestros, type MaestrosDePrueba } from './testing/maestros';

const run = process.env['RUN_INTEGRATION'] ? describe : describe.skip;

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const APP_DB =
  process.env['TEST_OPERACIONES_DATABASE_URL'] ??
  'postgresql://app_operaciones:dev_app_operaciones@localhost:6432/dynadrill?pgbouncer=true';
const MIGRATOR_DB =
  process.env['TEST_MIGRATOR_DATABASE_URL'] ??
  'postgresql://dyn_migrator:dev_dyn_migrator@localhost:5433/dynadrill';

const n = Date.now();
const P = Permission;

/** Cuentas reales de prueba: el ticket guarda quién actuó y a quién se asignó (FK a identidad). */
const JEFE = uuidv7();
const OPERADOR_QUE_ACTUA = uuidv7();
const SUPERVISORA = { id: uuidv7(), nombre: 'Sara Supervisora' };
const OPERADORES = [
  { id: uuidv7(), nombre: 'Oscar Operador' },
  { id: uuidv7(), nombre: 'Olga Operadora' },
];
const SUPERVISOR_PUMPING = { id: uuidv7(), nombre: 'Pablo Supervisor Pumping' };
const SIN_ROL_OPERADOR = { id: uuidv7(), nombre: 'Vera Ventas Real' };
const CLIENTE = { id: uuidv7(), nombre: `Cliente IT ${n}`, ruc: `88${String(n).slice(-11)}` };
const CAMPO = { id: uuidv7(), nombre: `SACHA ${n}` };
const BLOQUE = { id: uuidv7(), nombre: `Bloque 60 ${n}` };
const POZO = { id: uuidv7(), nombre: `ESTACION-${n}`, campoId: CAMPO.id, bloqueId: BLOQUE.id };
const POZO_BANDEJA = {
  id: uuidv7(),
  nombre: `BANDEJA-${n}`,
  campoId: CAMPO.id,
  bloqueId: BLOQUE.id,
};
const VEHICULO = { id: uuidv7(), placa: `IT${String(n).slice(-5)}P` };
const VEHICULO_2 = { id: uuidv7(), placa: `IT${String(n).slice(-5)}Q` };
const BODEGA = { id: uuidv7(), nombre: `BODEGA-PU ${n}` };
const MAESTROS: MaestrosDePrueba = {
  usuarios: [
    { id: JEFE, nombre: 'Jaime Jefe de Base', rol: 'jefe_base' },
    { id: OPERADOR_QUE_ACTUA, nombre: 'Oscar Operador', rol: 'operador' },
    { id: SUPERVISORA.id, nombre: SUPERVISORA.nombre, rol: 'supervisor' },
    { id: SUPERVISOR_PUMPING.id, nombre: SUPERVISOR_PUMPING.nombre, rol: 'supervisor_pumping' },
    ...OPERADORES.map((o) => ({ id: o.id, nombre: o.nombre, rol: 'operador' })),
    { id: SIN_ROL_OPERADOR.id, nombre: SIN_ROL_OPERADOR.nombre, rol: 'ingenieria_ventas' },
  ],
  clientes: [CLIENTE],
  campos: [CAMPO],
  bloques: [BLOQUE],
  pozos: [POZO, POZO_BANDEJA],
  vehiculos: [VEHICULO, VEHICULO_2],
  bodegas: [BODEGA],
};

run('Pumping: tickets de los pedidos abiertos (base de datos real)', () => {
  jest.setTimeout(90000);
  let app: INestApplication;
  let prisma: PrismaService;
  let consumer: PedidosAbiertosConsumer;
  let externos: RequisitosExternosConsumer;
  let diaCorregido: DiaCorregidoConsumer;
  let resultadoCambio: ResultadoCambioItemsConsumer;
  const admin = new Pool({ connectionString: MIGRATOR_DB, max: 2 });
  const http = () => request(app.getHttpServer());
  const signer = new JwtService({
    privateKey,
    signOptions: { algorithm: 'RS256', issuer: 'dynadrill-plataforma', expiresIn: 600 },
  });
  const token = (roleCode: string, name: string, permissions: string[], sub = uuidv7()) => ({
    Authorization: `Bearer ${signer.sign({ sub, email: `${roleCode}@test.local`, name, roleId: 'r', roleCode, permissions })}`,
  });
  const jefe = () => token('jefe_base', 'Jaime Jefe de Base', [P.PUMPING_OPERAR], JEFE);
  const operador = () =>
    token('operador', 'Oscar Operador', [P.PUMPING_OPERAR], OPERADOR_QUE_ACTUA);
  const sinPermiso = () => token('ingenieria_ventas', 'Vera Ventas', []);

  const pedidos: string[] = [];
  const eventos: string[] = [];
  /** Números de ticket de prueba (únicos): en producción los reserva `comercial` del secuencial de la prefactura. */
  let ticketSeq = 800_000 + (n % 100_000) * 10;

  const evento = (
    extra: Partial<EventEnvelope> & { data?: Record<string, unknown> } = {},
  ): EventEnvelope => {
    const pedidoId = (extra.subject?.id as string) ?? uuidv7();
    if (!pedidos.includes(pedidoId)) pedidos.push(pedidoId);
    const id = extra.id ?? uuidv7();
    eventos.push(id);
    return {
      id,
      type: 'comercial.pedido.abierto',
      version: 1,
      occurredAt: '2026-11-02T10:00:00.000Z',
      source: 'comercial',
      subject: { type: 'pedido', id: pedidoId },
      data: {
        codigo: `PED-IT${n}`,
        lineaServicio: 'pumping',
        tipoOt: 'servicio',
        tiposServicio: ['pumping', 'nitrogeno'],
        ticketNumero: ticketSeq++,
        clienteId: CLIENTE.id,
        campoId: CAMPO.id,
        bloqueId: BLOQUE.id,
        pozoId: POZO.id,
        taladroId: null,
        rigless: true,
        numeroContrato: 'CT-IT',
        fechaInicioServicio: '2026-11-05',
        as2Numero: null,
        ...extra.data,
      },
      ...(extra.id ? {} : {}),
    } as EventEnvelope;
  };

  beforeAll(async () => {
    await sembrarMaestros(admin, MAESTROS);
    Object.assign(process.env, {
      SERVICE_NAME: 'operaciones-test',
      PORT: '3196',
      LOG_LEVEL: 'silent',
      DATABASE_URL: APP_DB,
      RABBITMQ_URL: 'amqp://x:x@localhost:5672',
      JWT_PUBLIC_KEY: publicKey,
    });
    const envSchema = defineEnv(baseEnvSchema, databaseEnvSchema, jwtVerifyEnvSchema);
    @Module({
      imports: [
        AppConfigModule.forRoot(envSchema),
        CommonModule.forRoot({ serviceName: 'operaciones-test' }),
        MessagingModule.forRoot({
          container: 'operaciones',
          schema: 'msg_operaciones',
          rabbitUrl: 'amqp://x:x@localhost:5672',
          databaseUrl: APP_DB,
          relay: { enabled: false },
        }),
        PumpingModule,
      ],
    })
    class TestAppModule {}
    const mod = await Test.createTestingModule({ imports: [TestAppModule] }).compile();
    app = mod.createNestApplication();
    configureApp(app, { corsOrigins: ['http://localhost:4200'] });
    // sin RabbitMQ: el receptor se invoca a mano; evitamos que intente suscribirse al arrancar
    jest
      .spyOn(PedidosAbiertosConsumer.prototype, 'onApplicationBootstrap')
      .mockResolvedValue(undefined);
    jest
      .spyOn(RequisitosExternosConsumer.prototype, 'onApplicationBootstrap')
      .mockResolvedValue(undefined);
    jest.spyOn(DespachosConsumer.prototype, 'onApplicationBootstrap').mockResolvedValue(undefined);
    jest
      .spyOn(DiaCorregidoConsumer.prototype, 'onApplicationBootstrap')
      .mockResolvedValue(undefined);
    jest
      .spyOn(ResultadoCambioItemsConsumer.prototype, 'onApplicationBootstrap')
      .mockResolvedValue(undefined);
    await app.init();
    prisma = app.get(PrismaService);
    consumer = app.get(PedidosAbiertosConsumer);
    externos = app.get(RequisitosExternosConsumer);
    diaCorregido = app.get(DiaCorregidoConsumer);
    resultadoCambio = app.get(ResultadoCambioItemsConsumer);
  });

  afterAll(async () => {
    // lo que los tickets movieron en Inventario (el kardex referencia al ticket) y lo que la prueba creó allí
    const deTickets = '(SELECT id FROM pumping.ticket WHERE pedido_id = ANY($1::uuid[]))';
    await admin.query(
      `DELETE FROM inventario.consumo_ticket WHERE ticket_pumping_id IN ${deTickets}`,
      [pedidos],
    );
    await admin.query(`DELETE FROM inventario.movimiento WHERE ticket_pumping_id IN ${deTickets}`, [
      pedidos,
    ]);
    if (pedidos.length)
      await admin.query('DELETE FROM pumping.ticket WHERE pedido_id = ANY($1::uuid[])', [pedidos]);
    await admin.query(
      "DELETE FROM inventario.movimiento WHERE articulo_id IN (SELECT id FROM inventario.articulo WHERE codigo LIKE '%-PU-' || $1)",
      [String(n)],
    );
    await admin.query("DELETE FROM inventario.articulo WHERE codigo LIKE '%-PU-' || $1", [
      String(n),
    ]);
    await admin.query(
      "DELETE FROM inventario.categoria_articulo WHERE nombre LIKE 'CAT-%-PU ' || $1",
      [String(n)],
    );
    await admin.query(
      "DELETE FROM archivos.archivo WHERE blob_key LIKE 'prueba/%' AND nombre_original = 'mezcla.pdf' AND subido_por = $1",
      [JEFE],
    );
    await admin.query(
      "DELETE FROM msg_operaciones.outbox WHERE datos->'data'->>'articuloCodigo' LIKE '%-PU-' || $1",
      [String(n)],
    );
    if (eventos.length) {
      await admin.query('DELETE FROM msg_operaciones.inbox WHERE id = ANY($1::uuid[])', [eventos]);
      await admin.query(
        "DELETE FROM msg_operaciones.outbox WHERE datos->'data'->>'pedidoId' = ANY($1::text[])",
        [pedidos],
      );
    }
    await quitarMaestros(admin, MAESTROS);
    await admin.end();
    await app.close();
  });

  it('crea el ticket de un pedido de Pumping con los ids del pedido (FK a los catálogos) y el primer paso, sin numeración propia', async () => {
    const e = evento();
    await consumer.consumir(e);
    const t = await prisma.ticket.findUniqueOrThrow({
      where: { pedidoId: e.subject.id },
      include: { tiposServicio: true, historial: true },
    });
    // el ticket lleva el número que comercial le reservó del secuencial de la prefactura (la prefactura tendrá el mismo)
    expect('codigo' in t).toBe(false);
    expect(t.ticketNumero).toBe(e.data['ticketNumero']);
    expect(t).toMatchObject({
      pasoCodigo: 'revision_inicial',
      pedidoCodigo: `PED-IT${n}`,
      clienteId: CLIENTE.id,
      campoId: CAMPO.id,
      pozoId: POZO.id,
      rigless: true,
      numeroContrato: 'CT-IT',
      version: 1,
    });
    expect(t.fechaInicioServicio?.toISOString().slice(0, 10)).toBe('2026-11-05');
    expect(t.tiposServicio.map((x) => x.tipoCodigo).sort()).toEqual(['nitrogeno', 'pumping']);
    expect(t.historial).toHaveLength(1);
    expect(t.historial[0]).toMatchObject({
      pasoAnterior: null,
      pasoNuevo: 'revision_inicial',
      origen: 'sistema',
      motivo: 'Pedido abierto',
    });
    // publica su propio evento para quien lo necesite
    const salida = await admin.query(
      "SELECT tipo FROM msg_operaciones.outbox WHERE datos->'data'->>'pedidoId' = $1",
      [e.subject.id],
    );
    expect(salida.rows.map((r: { tipo: string }) => r.tipo)).toEqual([
      'operaciones.pumping.ticket_creado',
    ]);
    const datos = await admin.query(
      "SELECT datos->'data'->>'ticketNumero' AS t FROM msg_operaciones.outbox WHERE datos->'data'->>'pedidoId' = $1",
      [e.subject.id],
    );
    expect(Number(datos.rows[0].t)).toBe(e.data['ticketNumero']);
  });

  it('no duplica el ticket si el evento se entrega dos veces ni si llega otro evento del mismo pedido', async () => {
    const e = evento();
    await consumer.consumir(e);
    await consumer.consumir(e); // mismo evento: lo ignora el inbox
    await consumer.consumir(evento({ subject: e.subject })); // otro evento del mismo pedido: ya tiene ticket
    expect(await prisma.ticket.count({ where: { pedidoId: e.subject.id } })).toBe(1);
  });

  it('ignora los pedidos de otra línea (FCR)', async () => {
    const e = evento({ data: { lineaServicio: 'fcr' } });
    await consumer.consumir(e);
    expect(await prisma.ticket.count({ where: { pedidoId: e.subject.id } })).toBe(0);
  });

  it('la bandeja del Jefe de Base muestra los tickets de la revisión inicial; el Operador no los ve como suyos', async () => {
    const e = evento({ data: { pozoId: POZO_BANDEJA.id } });
    await consumer.consumir(e);
    const mios = await http()
      .get('/api/operaciones/pumping/tickets?mios=true')
      .set(jefe())
      .expect(200);
    const fila = mios.body.find((t: { pedidoId: string }) => t.pedidoId === e.subject.id);
    expect(fila).toMatchObject({
      pedidoCodigo: `PED-IT${n}`,
      cliente: CLIENTE.nombre,
      pozo: POZO_BANDEJA.nombre,
      taladro: 'RIGLESS',
      tiposServicio: ['nitrogeno', 'pumping'],
      paso: {
        codigo: 'revision_inicial',
        nombre: 'Revisión inicial',
        macro: 'pendiente',
        roles: ['jefe_base'],
      },
    });
    const delOperador = await http()
      .get('/api/operaciones/pumping/tickets?mios=true')
      .set(operador())
      .expect(200);
    expect(
      delOperador.body.find((t: { pedidoId: string }) => t.pedidoId === e.subject.id),
    ).toBeUndefined();
    // búsqueda y filtro por paso
    const q = await http()
      .get(`/api/operaciones/pumping/tickets?q=BANDEJA-${n}`)
      .set(jefe())
      .expect(200);
    expect(q.body).toHaveLength(1);
    expect(q.body[0]).not.toHaveProperty('codigo');
    expect(q.body[0].ticketNumero).toBe(e.data['ticketNumero']);
    // también se busca por el número de ticket
    const porNumero = await http()
      .get(`/api/operaciones/pumping/tickets?q=${e.data['ticketNumero']}`)
      .set(jefe())
      .expect(200);
    expect(porNumero.body.map((t: { pedidoId: string }) => t.pedidoId)).toEqual([e.subject.id]);
    expect(
      (
        await http()
          .get(`/api/operaciones/pumping/tickets?paso=cierre&q=BANDEJA-${n}`)
          .set(jefe())
          .expect(200)
      ).body,
    ).toHaveLength(0);
    await http().get('/api/operaciones/pumping/tickets').set(sinPermiso()).expect(403);
    await http().get('/api/operaciones/pumping/tickets').expect(401);
  });

  it('el Jefe de Base pasa el ticket de la revisión inicial a la asignación; otro rol no, y no hay más pasos todavía', async () => {
    const e = evento();
    await consumer.consumir(e);
    const t = await prisma.ticket.findUniqueOrThrow({ where: { pedidoId: e.subject.id } });
    const url = `/api/operaciones/pumping/tickets/${t.id}`;
    const antes = (await http().get(url).set(jefe()).expect(200)).body;
    expect(antes).toMatchObject({
      puedeActuar: true,
      siguientes: [{ codigo: 'asignacion', nombre: 'Asignación', requiereMotivo: false }],
    });
    expect((await http().get(url).set(operador()).expect(200)).body).toMatchObject({
      puedeActuar: false,
      siguientes: [],
    });

    await http().post(`${url}/avanzar`).set(operador()).send({ hacia: 'asignacion' }).expect(403);
    await http().post(`${url}/avanzar`).set(jefe()).send({ hacia: 'cierre' }).expect(409); // paso que no existe desde aquí
    await http().post(`${url}/avanzar`).set(jefe()).send({}).expect(400);
    const r = await http()
      .post(`${url}/avanzar`)
      .set(jefe())
      .send({ hacia: 'asignacion' })
      .expect(201);
    expect(r.body.paso).toMatchObject({ codigo: 'asignacion', macro: 'en_proceso' });
    expect(r.body.version).toBe(2);
    expect(r.body.historial.map((h: { pasoNuevo: string }) => h.pasoNuevo)).toEqual([
      'revision_inicial',
      'asignacion',
    ]);
    expect(r.body.historial[1]).toMatchObject({
      pasoAnterior: 'revision_inicial',
      actor: { nombre: 'Jaime Jefe de Base', rol: 'jefe_base' },
      origen: 'manual',
    });
    // desde la asignación todavía no hay pasos (se agregan con sus condiciones en la siguiente fase)
    await http().post(`${url}/avanzar`).set(jefe()).send({ hacia: 'traslado_salida' }).expect(409);
    await http().get(`/api/operaciones/pumping/tickets/${uuidv7()}`).set(jefe()).expect(404);
  });

  // ------------------------------------------------------------------------------------------------------------------
  // Asignación emparejada y traslado de salida
  // ------------------------------------------------------------------------------------------------------------------
  const OP1 = OPERADORES[0];
  const OP2 = OPERADORES[1];
  const como = (
    roleCode: string,
    id: string,
    nombre: string,
    permisos: string[] = [P.PUMPING_OPERAR],
  ) => token(roleCode, nombre, permisos, id);
  const op1 = () => como('operador', OP1.id, OP1.nombre);
  const op2 = () => como('operador', OP2.id, OP2.nombre);
  const supervisora = () => como('supervisor', SUPERVISORA.id, SUPERVISORA.nombre);
  const jefeConPuente = () =>
    como('jefe_base', JEFE, 'Jaime Jefe de Base', [P.PUMPING_OPERAR, P.PUMPING_REQUISITOS_PUENTE]);
  const cuerpoAsignacion = {
    supervisorId: SUPERVISORA.id,
    operadores: [
      { usuarioId: OP1.id, vehiculoId: VEHICULO.id },
      { usuarioId: OP2.id, vehiculoId: VEHICULO_2.id },
    ],
  };
  const base = '/api/operaciones/pumping';

  /** Ticket nuevo, pasado a Asignación (listo para asignar). */
  const ticketEnAsignacion = async () => {
    const e = evento();
    await consumer.consumir(e);
    const t = await prisma.ticket.findUniqueOrThrow({ where: { pedidoId: e.subject.id } });
    const url = `${base}/tickets/${t.id}`;
    await http().post(`${url}/avanzar`).set(jefe()).send({ hacia: 'asignacion' }).expect(201);
    return { id: t.id, url, pedidoId: e.subject.id as string };
  };
  /** Ticket asignado: ya está en Traslado de salida con sus requisitos creados. */
  const ticketEnTraslado = async () => {
    const t = await ticketEnAsignacion();
    await http().post(`${t.url}/asignar`).set(jefe()).send(cuerpoAsignacion).expect(201);
    return t;
  };
  const externo = (type: string, data: Record<string, unknown>, source = 'qhse'): EventEnvelope => {
    const id = uuidv7();
    eventos.push(id);
    return {
      id,
      type,
      version: 1,
      occurredAt: new Date().toISOString(),
      source,
      subject: { type: 'pumping_ticket', id: String(data['ticketId']) },
      data,
    } as EventEnvelope;
  };
  const requisitosDe = async (ticketId: string) =>
    (
      await prisma.ticketRequisito.findMany({
        where: { ticketId },
        include: { vehiculo: true, usuario: true },
      })
    ).map((r) => ({
      codigo: r.requisitoCodigo,
      estado: r.estado,
      origen: r.origen,
      para: r.vehiculo?.placa ?? r.usuario?.nombre ?? null,
      id: r.id,
    }));
  /** Cumple lo que exige el traslado de salida salvo el reporte de unidad: términos, EPI e inspección de vehículos (el checklist de ingreso es de la ejecución). */
  const cumplirTodoMenosReporte = async (id: string) => {
    for (const o of [op1(), op2()])
      await http().post(`${base}/tickets/${id}/terminos/aceptar`).set(o).expect(201);
    for (const o of [OP1, OP2])
      await externos.consumir(externo('qhse.epi.despachada', { ticketId: id, usuarioId: o.id }));
    for (const v of [VEHICULO, VEHICULO_2]) {
      await externos.consumir(
        externo('flota.inspeccion_vehiculo.realizada', { ticketId: id, vehiculoId: v.id }, 'flota'),
      );
    }
  };
  const salidaValida = async (id: string, vehiculoId: string) => {
    const r = (
      await http()
        .get(`${base}/tickets/${id}/reportes-unidad/${vehiculoId}`)
        .set(supervisora())
        .expect(200)
    ).body;
    return {
      fecha: '2026-11-05',
      combustible: 80.5,
      origen: 'Base Dynadrill',
      destino: 'Pozo del servicio',
      hubodometros: [
        { eje: 'A', punto: 'origen', salida: 1000 },
        { eje: 'B', punto: 'origen', salida: 2000.5 },
        { eje: 'A', punto: 'destino', salida: null },
      ],
      llantas: [{ posicion: 'delantera_izquierda', salida: '80 PSI' }],
      inspecciones: r.inspecciones
        .slice(0, 3)
        .map((i: { itemId: string }) => ({ itemId: i.itemId, resultado: 'conforme' })),
    };
  };

  it('el Jefe de Base asigna cada operador con su unidad: el ticket pasa a Traslado de salida, se crean sus requisitos y se publica el evento con las cuentas elegidas', async () => {
    const t = await ticketEnAsignacion();
    const url = `${t.url}/asignar`;
    // aún en la revisión inicial no se asigna (se probó antes de avanzar en otro ticket); aquí validamos el cuerpo
    await http().post(url).set(operador()).send(cuerpoAsignacion).expect(403);
    await http()
      .post(url)
      .set(jefe())
      .send({ ...cuerpoAsignacion, operadores: [] })
      .expect(400);
    await http()
      .post(url)
      .set(jefe())
      .send({
        ...cuerpoAsignacion,
        operadores: [{ usuarioId: SUPERVISORA.id, vehiculoId: VEHICULO.id }],
      })
      .expect(400); // el supervisor no es operador
    await http()
      .post(url)
      .set(jefe())
      .send({
        ...cuerpoAsignacion,
        operadores: [cuerpoAsignacion.operadores[0], cuerpoAsignacion.operadores[0]],
      })
      .expect(400); // persona repetida
    await http()
      .post(url)
      .set(jefe())
      .send({ ...cuerpoAsignacion, supervisorId: uuidv7() })
      .expect(400);
    await http()
      .post(url)
      .set(jefe())
      .send({ ...cuerpoAsignacion, operadores: [{ usuarioId: OP1.id, vehiculoId: uuidv7() }] })
      .expect(400); // unidad inexistente
    await http()
      .post(url)
      .set(jefe())
      .send({
        ...cuerpoAsignacion,
        operadores: [{ usuarioId: SIN_ROL_OPERADOR.id, vehiculoId: VEHICULO.id }],
      })
      .expect(400); // no es operador
    await http()
      .post(url)
      .set(jefe())
      .send({
        ...cuerpoAsignacion,
        supervisorId: OP1.id,
        operadores: [{ usuarioId: OP2.id, vehiculoId: VEHICULO.id }],
      })
      .expect(400); // un operador no es supervisor

    const r = await http().post(url).set(jefe()).send(cuerpoAsignacion).expect(201);
    expect(r.body.paso).toMatchObject({ codigo: 'traslado_salida' });
    expect(r.body.asignacion.supervisor).toEqual({
      usuarioId: SUPERVISORA.id,
      nombre: SUPERVISORA.nombre,
    });
    expect(r.body.asignacion.operadores).toEqual([
      { usuarioId: OP2.id, nombre: OP2.nombre, vehiculoId: VEHICULO_2.id, placa: VEHICULO_2.placa },
      { usuarioId: OP1.id, nombre: OP1.nombre, vehiculoId: VEHICULO.id, placa: VEHICULO.placa },
    ]);
    expect(r.body.asignacion.unidades.map((u: { placa: string }) => u.placa).sort()).toEqual(
      [VEHICULO.placa, VEHICULO_2.placa].sort(),
    );
    // lo que el proceso exige: del ticket 5 (checklist de ingreso, formalización de la ejecución, gerenciamiento de viaje de salida y de retorno, acta de entrega), 4 por unidad (con el reporte de llegada), 2 por operador
    const req = await requisitosDe(t.id);
    expect(req).toHaveLength(5 + 4 * 2 + 2 * 2);
    expect(req.every((x) => x.estado === 'pendiente')).toBe(true);
    expect(
      req
        .filter((x) => x.codigo === 'epi_despachado')
        .map((x) => x.para)
        .sort(),
    ).toEqual([OP1.nombre, OP2.nombre].sort());
    expect(r.body.requisitos).toHaveLength(req.length);
    // ya no está en Asignación
    await http().post(url).set(jefe()).send(cuerpoAsignacion).expect(403); // el paso lo atiende ahora el operador
    const salida = await admin.query(
      "SELECT datos->'data' AS d FROM msg_operaciones.outbox WHERE tipo = 'operaciones.pumping.asignacion_realizada' AND datos->'data'->>'pedidoId' = $1",
      [t.pedidoId],
    );
    expect(salida.rows).toHaveLength(1);
    const d = salida.rows[0].d;
    expect(d).toMatchObject({
      supervisor: SUPERVISORA.nombre,
      asignadoPor: 'Jaime Jefe de Base',
      cliente: CLIENTE.nombre,
      campo: CAMPO.nombre,
      pozo: POZO.nombre,
    });
    expect(d.asignados).toEqual(
      [
        { usuarioId: SUPERVISORA.id, rolCodigo: 'supervisor' },
        { usuarioId: OP1.id, rolCodigo: 'operador' },
        { usuarioId: OP2.id, rolCodigo: 'operador' },
      ].sort((a, b) => 0 * (a.usuarioId < b.usuarioId ? -1 : 1)),
    );
    expect(d.operadoresUnidades).toEqual(
      expect.arrayContaining([
        { usuarioId: OP1.id, vehiculoId: VEHICULO.id },
        { usuarioId: OP2.id, vehiculoId: VEHICULO_2.id },
      ]),
    );
  });

  it('un supervisor de Pumping también puede ser el supervisor del servicio', async () => {
    const t = await ticketEnAsignacion();
    const r = await http()
      .post(`${t.url}/asignar`)
      .set(jefe())
      .send({ ...cuerpoAsignacion, supervisorId: SUPERVISOR_PUMPING.id })
      .expect(201);
    expect(r.body.asignacion.supervisor).toEqual({
      usuarioId: SUPERVISOR_PUMPING.id,
      nombre: SUPERVISOR_PUMPING.nombre,
    });
    expect(await prisma.ticketPersona.count({ where: { ticketId: t.id } })).toBe(3);
  });

  it('desde la asignación el ticket es del equipo asignado: lo ve en su bandeja y solo ellos lo mueven', async () => {
    const t = await ticketEnTraslado();
    const mios = async (h: Record<string, string>) =>
      (
        await http()
          .get(`${base}/tickets?mios=true&q=${t.pedidoId ? '' : ''}`)
          .set(h)
          .expect(200)
      ).body.map((x: { id: string }) => x.id);
    // el operador asignado ve el ticket en su bandeja; otro operador (no asignado) no
    expect(await mios(op1())).toContain(t.id);
    expect(await mios(operador())).not.toContain(t.id);
    // el supervisor tiene el paso de salida pendiente de revisión más adelante; hoy el paso es del operador
    expect(await mios(supervisora())).not.toContain(t.id);
    // un operador no asignado no puede avanzarlo ni llenar nada
    await http()
      .post(`${t.url}/avanzar`)
      .set(operador())
      .send({ hacia: 'revision_reportes_salida' })
      .expect(403);
    await http()
      .patch(`${t.url}/ingreso`.replace('/tickets/', '/tickets/'))
      .set(operador())
      .send({ toolboxTalkRealizado: true })
      .expect(403);
    // el detalle muestra si puede actuar
    expect((await http().get(t.url).set(op1()).expect(200)).body).toMatchObject({
      puedeActuar: true,
    });
    expect((await http().get(t.url).set(operador()).expect(200)).body).toMatchObject({
      puedeActuar: false,
    });
  });

  it('salir de Traslado de salida exige todos los requisitos del paso y dice exactamente cuáles faltan', async () => {
    const t = await ticketEnTraslado();
    const r = await http()
      .post(`${t.url}/avanzar`)
      .set(op1())
      .send({ hacia: 'revision_reportes_salida' })
      .expect(409);
    expect(r.body.code).toBe('REQUISITOS_PENDIENTES');
    const falta = String(r.body.detail)
      .replace(/^.*Falta: /, '')
      .replace(/\.$/, '')
      .split('; ');
    expect(falta).toHaveLength(2 + 2 * 2 + 2); // 2 inspecciones, 2 EPI + 2 términos, 2 reportes (el checklist de ingreso es de la ejecución)
    expect(falta).toContain(`Entrega de EPI despachada (${OP1.nombre})`);
    expect(falta).toContain(`Reporte de unidad de salida (${VEHICULO.placa})`);
  });

  it('términos y condiciones: cada operador asignado acepta la versión vigente con su propia cuenta; es una constancia inmutable', async () => {
    const t = await ticketEnTraslado();
    const v = (await http().get(`${base}/terminos/vigente`).set(op1()).expect(200)).body;
    expect(v).toMatchObject({ codigo: 'PUMP-TyC-v1' });
    expect(v.textoHash).toMatch(/^[0-9a-f]{64}$/);
    expect(v.texto).toContain('Recepción.');
    // quien no es operador del ticket no puede aceptar; tampoco el supervisor
    await http()
      .post(`${t.url}/terminos/aceptar`.replace(`${base}/tickets`, `${base}/tickets`))
      .set(operador())
      .expect(403);
    await http().post(`${t.url}/terminos/aceptar`).set(supervisora()).expect(403);
    const a = await http().post(`${t.url}/terminos/aceptar`).set(op1()).expect(201);
    expect(a.body.versionCodigo).toBe('PUMP-TyC-v1');
    await http().post(`${t.url}/terminos/aceptar`).set(op1()).expect(201); // idempotente
    expect(await prisma.aceptacionTerminos.count({ where: { ticketId: t.id } })).toBe(1);
    const estado = (await http().get(`${t.url}/terminos`).set(supervisora()).expect(200)).body;
    expect(estado).toEqual([
      { usuarioId: OP2.id, nombre: OP2.nombre, aceptacion: null },
      {
        usuarioId: OP1.id,
        nombre: OP1.nombre,
        aceptacion: expect.objectContaining({ versionCodigo: 'PUMP-TyC-v1', esVigente: true }),
      },
    ]);
    const req = await requisitosDe(t.id);
    expect(
      req.find((x) => x.codigo === 'terminos_aceptados' && x.para === OP1.nombre),
    ).toMatchObject({ estado: 'cumplido', origen: 'sistema' });
    expect(
      req.find((x) => x.codigo === 'terminos_aceptados' && x.para === OP2.nombre),
    ).toMatchObject({ estado: 'pendiente' });
    // la base de datos protege la constancia: no se modifica
    await expect(
      prisma.$executeRaw`UPDATE pumping.aceptacion_terminos SET aceptado_at = now() WHERE ticket_id = ${t.id}::uuid`,
    ).rejects.toThrow();
  });

  it('checklist de ingreso a locación (al iniciar la ejecución): se completa con las confirmaciones, los gases seguros y el LOTO; si vuelve a quedar incompleto reabre el requisito', async () => {
    const t = await ticketEnTraslado();
    const url = `${t.url}/ingreso`;
    // en el traslado de salida todavía no se llena
    await http().patch(url).set(supervisora()).send({ toolboxTalkRealizado: true }).expect(409);
    // la ejecución llega con sus pasos propios (aún sin construir): aquí se lleva el ticket a ese paso
    await admin.query(
      "UPDATE pumping.ticket SET paso_codigo = 'ejecucion_operativa' WHERE id = $1",
      [t.id],
    );
    const inicial = (await http().get(url).set(supervisora()).expect(200)).body;
    expect(inicial.completo).toBe(false);
    expect(inicial.loto).toHaveLength(4);
    expect(inicial.limites.map((l: { gas: string }) => l.gas)).toEqual(['h2s', 'lel', 'o2', 'co']);

    await http()
      .patch(url)
      .set(supervisora())
      .send({
        toolboxTalkRealizado: true,
        walkaroundCompletado: true,
        lineaBaseAmbientalDocumentada: true,
        rutasEmergenciaVerificadas: true,
        simopsConfirmado: true,
      })
      .expect(200);
    // una lectura insegura no cuenta; la última lectura de cada gas es la que vale
    const insegura = (
      await http()
        .patch(url)
        .set(supervisora())
        .send({ nuevaLectura: { gas: 'h2s', lectura: 15 } })
        .expect(200)
    ).body;
    expect(insegura.lecturas.at(-1)).toMatchObject({
      gas: 'h2s',
      lectura: 15,
      seguro: false,
      medidoPor: SUPERVISORA.nombre,
    });
    for (const l of [
      { gas: 'h2s', lectura: 3 },
      { gas: 'lel', lectura: 0 },
      { gas: 'o2', lectura: 19.5 },
      { gas: 'co', lectura: 24.9 },
    ]) {
      await http().patch(url).set(supervisora()).send({ nuevaLectura: l }).expect(200);
    }
    const sinLoto = (await http().get(url).set(supervisora()).expect(200)).body;
    expect(sinLoto.completo).toBe(false);
    expect(sinLoto.lecturas.filter((l: { gas: string }) => l.gas === 'o2')[0].seguro).toBe(true); // 19.5 es el mínimo, inclusive
    for (const l of sinLoto.loto)
      await http().patch(`${url}/loto/${l.itemId}`).set(op1()).expect(200);
    const completo = (await http().get(url).set(supervisora()).expect(200)).body;
    expect(completo).toMatchObject({ completo: true, confirmadoPor: expect.any(String) });
    expect(completo.lotoNotificadoClienteAt).not.toBeNull();
    expect(
      (await requisitosDe(t.id)).find((x) => x.codigo === 'checklist_ingreso_locacion'),
    ).toMatchObject({ estado: 'cumplido', origen: 'sistema' });

    // desmarcar un ítem lo deja incompleto y reabre el requisito
    await http().patch(`${url}/loto/${completo.loto[0].itemId}`).set(op1()).expect(200);
    expect((await http().get(url).set(supervisora()).expect(200)).body).toMatchObject({
      completo: false,
      confirmadoPor: null,
    });
    expect(
      (await requisitosDe(t.id)).find((x) => x.codigo === 'checklist_ingreso_locacion'),
    ).toMatchObject({ estado: 'pendiente' });

    // validaciones
    await http()
      .patch(url)
      .set(supervisora())
      .send({ nuevaLectura: { gas: 'xx', lectura: 1 } })
      .expect(400);
    await http()
      .patch(url)
      .set(supervisora())
      .send({ nuevaLectura: { gas: 'co', lectura: -1 } })
      .expect(400);
    await http().patch(url).set(operador()).send({ toolboxTalkRealizado: false }).expect(403); // no es del equipo
  });

  it('requisitos de otros módulos: los cumple el evento de su dueño (idempotente) y, mientras no existan, el puente temporal con motivo', async () => {
    const t = await ticketEnTraslado();
    const e = externo('qhse.epi.despachada', { ticketId: t.id, usuarioId: OP1.id });
    await externos.consumir(e);
    await externos.consumir(e); // repetido: lo ignora el inbox
    let req = await requisitosDe(t.id);
    expect(req.find((x) => x.codigo === 'epi_despachado' && x.para === OP1.nombre)).toMatchObject({
      estado: 'cumplido',
      origen: 'evento',
    });
    expect(req.find((x) => x.codigo === 'epi_despachado' && x.para === OP2.nombre)).toMatchObject({
      estado: 'pendiente',
    });
    // un evento revertido lo reabre
    await externos.consumir(externo('qhse.epi.revertida', { ticketId: t.id, usuarioId: OP1.id }));
    req = await requisitosDe(t.id);
    expect(req.find((x) => x.codigo === 'epi_despachado' && x.para === OP1.nombre)).toMatchObject({
      estado: 'pendiente',
      origen: null,
    });
    // eventos de Flota
    await externos.consumir(
      externo(
        'flota.inspeccion_vehiculo.realizada',
        { ticketId: t.id, vehiculoId: VEHICULO.id },
        'flota',
      ),
    );
    req = await requisitosDe(t.id);
    expect(
      req.find((x) => x.codigo === 'inspeccion_vehiculo_realizada' && x.para === VEHICULO.placa),
    ).toMatchObject({ estado: 'cumplido', origen: 'evento' });
    // gerenciamiento de viaje (lo aprueba su dueño): uno de salida y otro de retorno por ticket
    await externos.consumir(
      externo('flota.gerenciamiento_viaje.aprobado', { ticketId: t.id, tipo: 'salida' }, 'flota'),
    );
    await externos.consumir(
      externo('flota.gerenciamiento_viaje.aprobado', { ticketId: t.id, tipo: 'otro' }, 'flota'),
    ); // tipo desconocido: se ignora
    req = await requisitosDe(t.id);
    expect(req.find((x) => x.codigo === 'gerenciamiento_viaje_salida_aprobado')).toMatchObject({
      estado: 'cumplido',
      origen: 'evento',
    });
    expect(req.find((x) => x.codigo === 'gerenciamiento_viaje_retorno_aprobado')).toMatchObject({
      estado: 'pendiente',
    });
    await externos.consumir(
      externo('flota.gerenciamiento_viaje.rechazado', { ticketId: t.id, tipo: 'salida' }, 'flota'),
    );
    expect(
      (await requisitosDe(t.id)).find((x) => x.codigo === 'gerenciamiento_viaje_salida_aprobado'),
    ).toMatchObject({ estado: 'pendiente' });
    // un evento sin ticket o de un tipo desconocido no rompe nada
    await externos.consumir(externo('qhse.epi.despachada', { usuarioId: OP1.id }));
    await externos.consumir(externo('qhse.otra_cosa', { ticketId: t.id }));

    // puente temporal: exige permiso y motivo, y no sirve para lo que cumple Pumping
    const epiOp2 = req.find((x) => x.codigo === 'epi_despachado' && x.para === OP2.nombre)!;
    const ingreso = req.find((x) => x.codigo === 'checklist_ingreso_locacion')!;
    await http()
      .post(`${base}/requisitos/${epiOp2.id}/cumplir-manual`)
      .set(jefe())
      .send({ motivo: 'x' })
      .expect(403); // sin el permiso
    await http()
      .post(`${base}/requisitos/${epiOp2.id}/cumplir-manual`)
      .set(jefeConPuente())
      .send({ motivo: '  ' })
      .expect(400);
    await http()
      .post(`${base}/requisitos/${ingreso.id}/cumplir-manual`)
      .set(jefeConPuente())
      .send({ motivo: 'prueba' })
      .expect(400);
    await http()
      .post(`${base}/requisitos/${epiOp2.id}/cumplir-manual`)
      .set(jefeConPuente())
      .send({ motivo: 'QHSE aún no está en el portal nuevo' })
      .expect(201);
    await http()
      .post(`${base}/requisitos/${epiOp2.id}/cumplir-manual`)
      .set(jefeConPuente())
      .send({ motivo: 'otra vez' })
      .expect(409);
    const fila = (await requisitosDe(t.id)).find((x) => x.id === epiOp2.id);
    expect(fila).toMatchObject({ estado: 'cumplido', origen: 'manual_temporal' });
    const bd = await admin.query(
      'SELECT motivo, cumplido_por FROM pumping.ticket_requisito WHERE id = $1',
      [epiOp2.id],
    );
    expect(bd.rows[0]).toEqual({
      motivo: 'QHSE aún no está en el portal nuevo',
      cumplido_por: JEFE,
    });
  });

  it('el reporte de unidad de salida lo firma el operador de cada unidad, solo con los demás requisitos cumplidos; con todo listo el ticket pasa a la revisión y se avisa al supervisor', async () => {
    const t = await ticketEnTraslado();
    const reporteUrl = (v: string) => `${t.url}/reportes-unidad/${v}/salida`;
    // el listado de unidades con su operador
    const lista = (await http().get(`${t.url}/reportes-unidad`).set(op1()).expect(200)).body;
    expect(lista).toEqual(
      [
        {
          vehiculoId: VEHICULO.id,
          placa: VEHICULO.placa,
          operador: { usuarioId: OP1.id, nombre: OP1.nombre },
          salidaFirmada: false,
          salidaFirmadaAt: null,
        },
        {
          vehiculoId: VEHICULO_2.id,
          placa: VEHICULO_2.placa,
          operador: { usuarioId: OP2.id, nombre: OP2.nombre },
          salidaFirmada: false,
          salidaFirmadaAt: null,
        },
      ].sort((a, b) => a.placa.localeCompare(b.placa)),
    );

    // sin los demás requisitos no se puede firmar
    const cuerpo1 = await salidaValida(t.id, VEHICULO.id);
    const bloqueado = await http()
      .put(reporteUrl(VEHICULO.id))
      .set(op1())
      .send(cuerpo1)
      .expect(409);
    expect(bloqueado.body.code).toBe('REQUISITOS_PENDIENTES');
    await cumplirTodoMenosReporte(t.id);

    // validaciones del cuerpo y de quién firma
    await http()
      .put(reporteUrl(VEHICULO.id))
      .set(op1())
      .send({ ...cuerpo1, fecha: '05/11/2026' })
      .expect(400);
    await http()
      .put(reporteUrl(VEHICULO.id))
      .set(op1())
      .send({ ...cuerpo1, origen: '  ' })
      .expect(400);
    await http()
      .put(reporteUrl(VEHICULO.id))
      .set(op1())
      .send({ ...cuerpo1, combustible: -1 })
      .expect(400);
    await http()
      .put(reporteUrl(VEHICULO.id))
      .set(op1())
      .send({ ...cuerpo1, hubodometros: [...cuerpo1.hubodometros, cuerpo1.hubodometros[0]] })
      .expect(400);
    await http()
      .put(reporteUrl(VEHICULO.id))
      .set(op1())
      .send({ ...cuerpo1, inspecciones: [{ itemId: uuidv7(), resultado: 'conforme' }] })
      .expect(400);
    await http().put(reporteUrl(VEHICULO_2.id)).set(op1()).send(cuerpo1).expect(403); // la unidad del otro operador
    await http().put(reporteUrl(VEHICULO.id)).set(operador()).send(cuerpo1).expect(403); // un operador que no es del ticket
    await http().put(reporteUrl(uuidv7())).set(op1()).send(cuerpo1).expect(404);
    // todavía no puede salir: faltan los reportes
    await http()
      .post(`${t.url}/avanzar`)
      .set(op1())
      .send({ hacia: 'revision_reportes_salida' })
      .expect(409);

    const firmado = (await http().put(reporteUrl(VEHICULO.id)).set(op1()).send(cuerpo1).expect(200))
      .body;
    expect(firmado).toMatchObject({
      placa: VEHICULO.placa,
      origen: 'Base Dynadrill',
      destino: 'Pozo del servicio',
      operador: { nombre: OP1.nombre },
    });
    expect(firmado.salida).toMatchObject({
      fecha: '2026-11-05',
      combustible: 80.5,
      firmadaPor: OP1.nombre,
    });
    expect(firmado.salida.firmadaAt).not.toBeNull();
    expect(firmado.hubodometros).toEqual([
      { eje: 'A', punto: 'origen', salida: 1000, llegada: null },
      { eje: 'A', punto: 'destino', salida: null, llegada: null },
      { eje: 'B', punto: 'origen', salida: 2000.5, llegada: null },
    ]);
    expect(firmado.llantas).toEqual([
      { posicion: 'delantera_izquierda', salida: '80 PSI', llegada: null },
    ]);
    expect(firmado.inspecciones).toHaveLength(59); // todos los ítems del formulario (20 + 20 + 16 + 3)
    expect(
      firmado.inspecciones.filter((i: { salida: string | null }) => i.salida === 'conforme'),
    ).toHaveLength(3);
    // se puede volver a guardar mientras siga en el paso (vuelve a firmar)
    await http()
      .put(reporteUrl(VEHICULO.id))
      .set(op1())
      .send({ ...cuerpo1, combustible: 70 })
      .expect(200);
    expect(
      (await http().get(`${t.url}/reportes-unidad/${VEHICULO.id}`).set(op1()).expect(200)).body
        .salida.combustible,
    ).toBe(70);

    // falta el de la otra unidad
    const aunFalta = await http()
      .post(`${t.url}/avanzar`)
      .set(op1())
      .send({ hacia: 'revision_reportes_salida' })
      .expect(409);
    expect(aunFalta.body.detail).toContain(`Reporte de unidad de salida (${VEHICULO_2.placa})`);
    expect(aunFalta.body.detail).not.toContain(VEHICULO.placa);
    const cuerpo2 = await salidaValida(t.id, VEHICULO_2.id);
    await http().put(reporteUrl(VEHICULO_2.id)).set(op2()).send(cuerpo2).expect(200);

    // todo cumplido: sale del traslado hacia la revisión de reportes de salida
    const r = await http()
      .post(`${t.url}/avanzar`)
      .set(op1())
      .send({ hacia: 'revision_reportes_salida' })
      .expect(201);
    expect(r.body.paso).toMatchObject({
      codigo: 'revision_reportes_salida',
      roles: ['supervisor', 'supervisor_pumping'],
    });
    // ahora el paso es del supervisor asignado (de su bandeja) y el operador ya no actúa
    expect(
      (await http().get(`${base}/tickets?mios=true`).set(supervisora()).expect(200)).body.map(
        (x: { id: string }) => x.id,
      ),
    ).toContain(t.id);
    expect((await http().get(t.url).set(supervisora()).expect(200)).body).toMatchObject({
      puedeActuar: true,
    });
    expect((await http().get(t.url).set(op1()).expect(200)).body).toMatchObject({
      puedeActuar: false,
    });
    // y no se puede volver a firmar la salida
    await http().put(reporteUrl(VEHICULO.id)).set(op1()).send(cuerpo1).expect(409);

    // en la revisión de salida falta aprobar la inspección de cada unidad (requisito de Mantenimiento)
    const falta = await http()
      .post(`${t.url}/avanzar`)
      .set(supervisora())
      .send({ hacia: 'ejecucion_operativa' })
      .expect(409); // aún no hay transición
    expect(falta.body).toBeDefined();
    const evento = await admin.query(
      "SELECT datos->'data' AS d FROM msg_operaciones.outbox WHERE tipo = 'operaciones.pumping.salida_reportada' AND datos->'data'->>'pedidoId' = $1",
      [t.pedidoId],
    );
    expect(evento.rows).toHaveLength(1);
    expect(evento.rows[0].d).toMatchObject({ reportadoPor: OP1.nombre, cliente: CLIENTE.nombre });
    expect(evento.rows[0].d.asignados).toEqual([
      { usuarioId: SUPERVISORA.id, rolCodigo: 'supervisor' },
    ]);
  });

  it('recorre todo el servicio: revisión de salida, ejecución, retorno, llegada, revisión final y cierre, con lo que exige cada paso', async () => {
    const t = await ticketEnTraslado();
    await cumplirTodoMenosReporte(t.id);
    for (const [v, o] of [
      [VEHICULO, op1()],
      [VEHICULO_2, op2()],
    ] as const) {
      const cuerpoSalida = await salidaValida(t.id, v.id);
      await http()
        .put(`${t.url}/reportes-unidad/${v.id}/salida`)
        .set(o)
        .send(cuerpoSalida)
        .expect(200);
    }
    await http()
      .post(`${t.url}/avanzar`)
      .set(op1())
      .send({ hacia: 'revision_reportes_salida' })
      .expect(201);

    // revisión de salida: inspección aprobada de cada unidad y gerenciamiento de viaje de salida aprobado
    const faltaRevision = await http()
      .post(`${t.url}/avanzar`)
      .set(supervisora())
      .send({ hacia: 'ejecucion_operativa' })
      .expect(409);
    expect(faltaRevision.body.detail).toContain('Inspección de vehículos aprobada');
    expect(faltaRevision.body.detail).toContain('Gerenciamiento de viaje de salida aprobado');
    for (const v of [VEHICULO, VEHICULO_2]) {
      await externos.consumir(
        externo(
          'flota.inspeccion_vehiculo.aprobada',
          { ticketId: t.id, vehiculoId: v.id },
          'flota',
        ),
      );
    }
    await externos.consumir(
      externo('flota.gerenciamiento_viaje.aprobado', { ticketId: t.id, tipo: 'salida' }, 'flota'),
    );
    await http()
      .post(`${t.url}/avanzar`)
      .set(supervisora())
      .send({ hacia: 'ejecucion_operativa' })
      .expect(201);

    // ejecución: checklist de ingreso (su prueba propia lo cubre; aquí se da por cumplido) y formalización del Supervisor
    const faltaEjecucion = await http()
      .post(`${t.url}/avanzar`)
      .set(op1())
      .send({ hacia: 'control_retorno' })
      .expect(409);
    expect(faltaEjecucion.body.detail).toContain('Formalización de la ejecución');
    const formalizar = `${t.url}/ejecucion/formalizar`;
    await http().post(formalizar).set(op1()).expect(403); // sin el permiso
    await http()
      .post(formalizar)
      .set(como('supervisor', OP1.id, OP1.nombre, [P.PUMPING_EJECUCION_FORMALIZAR]))
      .expect(403); // con el permiso, pero no es el supervisor asignado
    await http()
      .post(formalizar)
      .set(como('supervisor', SUPERVISORA.id, SUPERVISORA.nombre, [P.PUMPING_EJECUCION_FORMALIZAR]))
      .expect(201);
    await prisma.ticketRequisito.updateMany({
      where: { ticketId: t.id, requisitoCodigo: 'checklist_ingreso_locacion' },
      data: { estado: 'cumplido', cumplidoAt: new Date(), origen: 'sistema' },
    });
    await http().post(`${t.url}/avanzar`).set(op1()).send({ hacia: 'control_retorno' }).expect(201);

    // control de retorno: gerenciamiento de viaje de retorno aprobado
    const faltaRetorno = await http()
      .post(`${t.url}/avanzar`)
      .set(supervisora())
      .send({ hacia: 'traslado_llegada' })
      .expect(409);
    expect(faltaRetorno.body.detail).toContain('Gerenciamiento de viaje de retorno aprobado');
    await externos.consumir(
      externo('flota.gerenciamiento_viaje.aprobado', { ticketId: t.id, tipo: 'retorno' }, 'flota'),
    );
    await http()
      .post(`${t.url}/avanzar`)
      .set(supervisora())
      .send({ hacia: 'traslado_llegada' })
      .expect(201);

    // traslado de llegada: cada operador firma la llegada de su unidad (publica el evento para Mantenimiento)
    await http()
      .post(`${t.url}/avanzar`)
      .set(op1())
      .send({ hacia: 'revision_reportes_llegada' })
      .expect(409);
    const llegada = async (vehiculoId: string, extra: object = {}) => {
      const r = (
        await http().get(`${t.url}/reportes-unidad/${vehiculoId}`).set(supervisora()).expect(200)
      ).body;
      return {
        fecha: '2026-11-09',
        combustible: 20,
        hubodometros: [{ eje: 'A', punto: 'destino', llegada: 1100 }],
        llantas: [{ posicion: 'delantera_izquierda', llegada: '78 PSI' }],
        inspecciones: r.inspecciones
          .slice(0, 3)
          .map((i: { itemId: string }) => ({ itemId: i.itemId, resultado: 'conforme' })),
        unidadLista: true,
        operacionInterrumpida: false,
        ...extra,
      };
    };
    const urlLlegada = (v: string) => `${t.url}/reportes-unidad/${v}/llegada`;
    // la unidad de otro operador, y la interrupción exige su detalle
    const cuerpoLlegada2 = await llegada(VEHICULO_2.id);
    await http().put(urlLlegada(VEHICULO_2.id)).set(op1()).send(cuerpoLlegada2).expect(403);
    const interrumpida = await llegada(VEHICULO.id, { operacionInterrumpida: true });
    const conNovedad = await llegada(VEHICULO.id, { novedadesMecanica: 'Ruido en el eje trasero' });
    await http().put(urlLlegada(VEHICULO.id)).set(op1()).send(interrumpida).expect(400);
    const l1 = (await http().put(urlLlegada(VEHICULO.id)).set(op1()).send(conNovedad).expect(200))
      .body;
    expect(l1.llegada).toMatchObject({
      fecha: '2026-11-09',
      combustible: 20,
      novedadesMecanica: 'Ruido en el eje trasero',
      unidadLista: true,
      operacionInterrumpida: false,
    });
    expect(l1.llegada.firmadaAt).not.toBeNull();
    // se conserva lo de la salida y se agrega la llegada en las mismas filas
    expect(l1.hubodometros).toContainEqual({
      eje: 'A',
      punto: 'destino',
      salida: null,
      llegada: 1100,
    });
    expect(l1.llantas).toEqual([
      { posicion: 'delantera_izquierda', salida: '80 PSI', llegada: '78 PSI' },
    ]);
    const aunFaltaLlegada = await http()
      .post(`${t.url}/avanzar`)
      .set(op1())
      .send({ hacia: 'revision_reportes_llegada' })
      .expect(409);
    expect(aunFaltaLlegada.body.detail).toContain(
      `Reporte de unidad de llegada (${VEHICULO_2.placa})`,
    );
    await http().put(urlLlegada(VEHICULO_2.id)).set(op2()).send(cuerpoLlegada2).expect(200);
    const eventosLlegada = await admin.query(
      "SELECT datos->'data' AS d FROM msg_operaciones.outbox WHERE tipo = 'operaciones.pumping.reporte_unidad_llegada' AND datos->'data'->>'ticketId' = $1",
      [t.id],
    );
    expect(eventosLlegada.rows).toHaveLength(2);
    expect(eventosLlegada.rows.map((x) => x.d.hayNovedades).sort()).toEqual([false, true]);
    await http()
      .post(`${t.url}/avanzar`)
      .set(op1())
      .send({ hacia: 'revision_reportes_llegada' })
      .expect(201);

    // revisión de llegada y revisión final: el cierre exige el Acta de Entrega de Locación; el rechazo vuelve con motivo
    await http()
      .post(`${t.url}/avanzar`)
      .set(supervisora())
      .send({ hacia: 'revision_final' })
      .expect(201);
    const faltaActa = await http()
      .post(`${t.url}/avanzar`)
      .set(supervisora())
      .send({ hacia: 'cierre' })
      .expect(409);
    expect(faltaActa.body.detail).toContain('Acta de Entrega de Locación');
    await http()
      .post(`${t.url}/avanzar`)
      .set(supervisora())
      .send({ hacia: 'revision_reportes_llegada' })
      .expect(400); // el rechazo exige motivo
    await http()
      .post(`${t.url}/avanzar`)
      .set(supervisora())
      .send({ hacia: 'revision_reportes_llegada', motivo: 'Falta aclarar la novedad mecánica' })
      .expect(201);
    await http()
      .post(`${t.url}/avanzar`)
      .set(supervisora())
      .send({ hacia: 'revision_final' })
      .expect(201);
    await externos.consumir(externo('qhse.acta_entrega.cargada', { ticketId: t.id }));
    const cerrado = await http()
      .post(`${t.url}/avanzar`)
      .set(supervisora())
      .send({ hacia: 'cierre' })
      .expect(201);
    expect(cerrado.body.paso).toMatchObject({ codigo: 'cierre' });
    const cierre = await admin.query(
      "SELECT datos->'data' AS d FROM msg_operaciones.outbox WHERE tipo = 'operaciones.pumping.cerrado' AND datos->'data'->>'ticketId' = $1",
      [t.id],
    );
    expect(cierre.rows).toHaveLength(1);
    expect(cierre.rows[0].d).toMatchObject({ ticketId: t.id, pedidoId: t.pedidoId });
    // un ticket cerrado ya no se mueve
    await http()
      .post(`${t.url}/avanzar`)
      .set(supervisora())
      .send({ hacia: 'revision_final' })
      .expect(409);
  });

  describe('químicos del ticket: salida de bodega al asignar, consumo y devolución (P1 y P4)', () => {
    const QUIMICO = { id: uuidv7(), codigo: `QUI-PU-${n}` };
    const NO_QUIMICO = { id: uuidv7(), codigo: `NOQ-PU-${n}` };
    const CATEGORIA_Q = uuidv7();
    const CATEGORIA_N = uuidv7();
    const MEZCLA = uuidv7();
    let preparado = false;

    /** Existencia del químico en la bodega de prueba, del último movimiento del kardex. */
    const stock = async () =>
      Number(
        (
          await admin.query(
            'SELECT saldo_resultante FROM inventario.movimiento WHERE articulo_id = $1 AND bodega_id = $2 ORDER BY secuencia DESC LIMIT 1',
            [QUIMICO.id, BODEGA.id],
          )
        ).rows[0].saldo_resultante,
      );

    const preparar = async () => {
      if (preparado) return;
      preparado = true;
      for (const [id, nombre, quimica] of [
        [CATEGORIA_Q, `CAT-QUI-PU ${n}`, true],
        [CATEGORIA_N, `CAT-NOQ-PU ${n}`, false],
      ] as const) {
        await admin.query(
          'INSERT INTO inventario.categoria_articulo (id, nombre, es_quimica) VALUES ($1, $2, $3)',
          [id, nombre, quimica],
        );
      }
      for (const [a, categoria] of [
        [QUIMICO, CATEGORIA_Q],
        [NO_QUIMICO, CATEGORIA_N],
      ] as const) {
        await admin.query(
          `INSERT INTO inventario.articulo (id, codigo, nombre, categoria_id, unidad_stock_id)
           VALUES ($1, $2, 'Articulo de prueba', $3, (SELECT id FROM inventario.unidad_stock ORDER BY nombre LIMIT 1))`,
          [a.id, a.codigo, categoria],
        );
      }
      await admin.query(
        `INSERT INTO archivos.archivo (id, modulo_id, nombre_original, mime_type, tamano_bytes, sha256, blob_key, escaneo, subido_por)
         SELECT $1::uuid, mo.id, 'mezcla.pdf', 'application/pdf', 10, repeat('b', 64), 'prueba/' || $1::text, 'omitido', $2::uuid
           FROM archivos.modulo_archivo mo WHERE mo.codigo = 'pedido_documento'`,
        [MEZCLA, JEFE],
      );
      const compra = (
        await admin.query("SELECT id FROM inventario.motivo_movimiento WHERE origen = 'compra'")
      ).rows[0].id;
      const bodeguero = token('bodeguero', 'Bruno Bodeguero', [P.ARTICULOS_GESTIONAR], JEFE);
      for (const a of [QUIMICO, NO_QUIMICO]) {
        await http()
          .post('/api/operaciones/inventario/movimientos')
          .set(bodeguero)
          .send({ articuloId: a.id, bodegaId: BODEGA.id, motivoId: compra, cantidad: 100 })
          .expect(201);
      }
    };

    const asignar = (t: { url: string }, extra: object) =>
      http()
        .post(`${t.url}/asignar`)
        .set(jefe())
        .send({ ...cuerpoAsignacion, ...extra });
    const linea = (cantidad: number, articulo = QUIMICO) => ({
      articuloId: articulo.id,
      bodegaId: BODEGA.id,
      cantidad,
    });
    const enPaso = (id: string, paso: string) =>
      admin.query('UPDATE pumping.ticket SET paso_codigo = $2 WHERE id = $1', [id, paso]);

    it('el selector de químicos de la asignación trae solo químicos con existencia, por bodega', async () => {
      await preparar();
      const r = await http()
        .get('/api/operaciones/inventario/articulos/quimicos')
        .query({ q: '-PU-' + n })
        .set(jefe());
      expect(r.status).toBe(200);
      expect(r.body.map((a: { codigo: string }) => a.codigo)).toEqual([QUIMICO.codigo]); // el no químico no aparece
      expect(r.body[0].porBodega).toEqual([
        expect.objectContaining({ bodegaId: BODEGA.id, stock: expect.any(Number) }),
      ]);
      expect(
        (await http().get('/api/operaciones/inventario/articulos/quimicos').set(sinPermiso()))
          .status,
      ).toBe(403);
    });

    it('asignar con químicos exige el documento de mezcla; con él, los químicos salen de bodega a cargo del ticket', async () => {
      await preparar();
      const t = await ticketEnAsignacion();
      const antes = await stock();

      const sinMezcla = await asignar(t, { quimicos: [linea(10)] });
      expect(sinMezcla.status).toBe(400);
      expect(sinMezcla.body.code).toBe('MEZCLA_REQUERIDA');
      expect(await stock()).toBe(antes);

      const ok = await asignar(t, { quimicos: [linea(10)], documentoMezclaId: MEZCLA });
      expect(ok.status).toBe(201);
      expect(ok.body.pasoCodigo ?? ok.body.paso?.codigo).toBe('traslado_salida');
      expect(await stock()).toBe(antes - 10);

      const q = await http().get(`${t.url}/quimicos`).set(jefe());
      expect(q.status).toBe(200);
      expect(q.body.quimicos).toEqual([
        expect.objectContaining({
          articuloId: QUIMICO.id,
          codigo: QUIMICO.codigo,
          asignada: 10,
          usada: 0,
          devuelta: 0,
          pendiente: 10,
          bodegas: [{ bodegaId: BODEGA.id, bodega: BODEGA.nombre }],
        }),
      ]);
      expect(q.body.documentos).toEqual([
        expect.objectContaining({ tipo: 'mezcla_quimica', archivoId: MEZCLA }),
      ]);
      // el documento es historia: la aplicación no lo cambia ni lo borra
      const app = new Pool({ connectionString: APP_DB.replace('?pgbouncer=true', ''), max: 1 });
      try {
        await expect(app.query('DELETE FROM pumping.ticket_documento')).rejects.toThrow(
          /permission denied/,
        );
      } finally {
        await app.end();
      }
    });

    it('si los químicos no alcanzan o no son químicos, la asignación no se hace y no sale nada', async () => {
      await preparar();
      const t = await ticketEnAsignacion();
      const antes = await stock();

      const excede = await asignar(t, { quimicos: [linea(5000)], documentoMezclaId: MEZCLA });
      expect(excede.status).toBe(409);
      const noQ = await asignar(t, {
        quimicos: [linea(1, NO_QUIMICO)],
        documentoMezclaId: MEZCLA,
      });
      expect(noQ.status).toBe(409);
      expect(noQ.body.code).toBe('ARTICULO_NO_QUIMICO');
      const sinArchivo = await asignar(t, { quimicos: [linea(1)], documentoMezclaId: uuidv7() });
      expect(sinArchivo.status).toBe(400);

      expect(await stock()).toBe(antes);
      const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } });
      expect(ticket.pasoCodigo).toBe('asignacion'); // sigue por asignar
      expect(await prisma.ticketDocumento.count({ where: { ticketId: t.id } })).toBe(0);
    });

    it('si la asignación falla después de la salida, la salida se deshace con una devolución', async () => {
      await preparar();
      const t = await ticketEnAsignacion();
      const antes = await stock();
      // se simula una falla al publicar el evento de la asignación, que ocurre DESPUÉS de la salida de bodega
      const publicar = EventBus.prototype.publish;
      const espia = jest.spyOn(EventBus.prototype, 'publish').mockImplementation(function (
        this: EventBus,
        tx,
        evento,
      ) {
        if (evento.type === 'operaciones.pumping.asignacion_realizada') {
          throw new Error('falla simulada');
        }
        return publicar.call(this, tx, evento);
      });
      try {
        const r = await asignar(t, { quimicos: [linea(7)], documentoMezclaId: MEZCLA });
        expect(r.status).toBe(500);
      } finally {
        espia.mockRestore();
      }
      expect(await stock()).toBe(antes); // salió y volvió
      const movimientos = await admin.query(
        'SELECT origen FROM inventario.movimiento WHERE ticket_pumping_id = $1 ORDER BY secuencia',
        [t.id],
      );
      expect(movimientos.rows.map((m) => m.origen)).toEqual(['salida_ticket', 'devolucion_ticket']);
      const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } });
      expect(ticket.pasoCodigo).toBe('asignacion');
      expect(await prisma.ticketDocumento.count({ where: { ticketId: t.id } })).toBe(0);
    });

    it('consumo y devolución: solo en su paso, por el equipo asignado y sin pasar de lo que el ticket tiene a su cargo', async () => {
      await preparar();
      const t = await ticketEnAsignacion();
      await asignar(t, { quimicos: [linea(10)], documentoMezclaId: MEZCLA }).expect(201);
      const antes = await stock();
      const consumo = (cantidad: number, h = op1()) =>
        http().post(`${t.url}/quimicos/consumo`).set(h).send({ articuloId: QUIMICO.id, cantidad });
      const devolucion = (cantidad: number, h = supervisora()) =>
        http()
          .post(`${t.url}/quimicos/devolucion`)
          .set(h)
          .send({ lineas: [linea(cantidad)] });

      // fuera de su paso
      expect((await consumo(1)).status).toBe(409);
      expect((await devolucion(1)).status).toBe(409);

      await enPaso(t.id, 'ejecucion_operativa');
      expect((await consumo(4, operador())).status).toBe(403); // no es del equipo
      expect((await consumo(11)).status).toBe(409); // más de lo asignado
      const c = await consumo(6);
      expect(c.status).toBe(201);
      expect(c.body.quimicos[0]).toMatchObject({ asignada: 10, usada: 6, pendiente: 4 });
      expect(await stock()).toBe(antes); // el consumo no mueve stock

      await enPaso(t.id, 'control_retorno');
      expect((await devolucion(2, op1())).status).toBe(403); // el operador no devuelve
      expect((await devolucion(5)).status).toBe(409); // sobran 4, no 5
      const d = await devolucion(4);
      expect(d.status).toBe(201);
      expect(d.body.quimicos[0]).toMatchObject({
        asignada: 10,
        usada: 6,
        devuelta: 4,
        pendiente: 0,
      });
      expect(await stock()).toBe(antes + 4);
    });
  });

  describe('revisión de reportes de salida: el Supervisor aprueba la inspección de cada unidad (P2)', () => {
    const aprobar = (t: { url: string }, vehiculoId: string, h = supervisora()) =>
      http().post(`${t.url}/revision-salida/inspecciones/${vehiculoId}/aprobar`).set(h);
    const inspeccion = async (id: string, vehiculoId: string) =>
      (
        await admin.query(
          "SELECT estado, origen, motivo, cumplido_por FROM pumping.ticket_requisito WHERE ticket_id = $1 AND requisito_codigo = 'inspeccion_vehiculo_aprobada' AND vehiculo_id = $2",
          [id, vehiculoId],
        )
      ).rows[0];

    it('solo en su paso, por el Supervisor del equipo, una sola vez por unidad y dejando constancia', async () => {
      const t = await ticketEnTraslado();
      // fuera de su paso
      expect((await aprobar(t, VEHICULO.id)).status).toBe(409);

      await admin.query('UPDATE pumping.ticket SET paso_codigo = $2 WHERE id = $1', [
        t.id,
        'revision_reportes_salida',
      ]);
      expect((await aprobar(t, VEHICULO.id, op1())).status).toBe(403); // el operador no aprueba
      expect((await aprobar(t, uuidv7())).status).toBe(404); // una unidad que no es del ticket

      const ok = await aprobar(t, VEHICULO.id);
      expect(ok.status).toBe(201);
      expect(await inspeccion(t.id, VEHICULO.id)).toMatchObject({
        estado: 'cumplido',
        origen: 'manual_temporal',
        cumplido_por: SUPERVISORA.id,
      });
      expect((await inspeccion(t.id, VEHICULO.id)).motivo).toContain('Supervisor');
      // la otra unidad sigue pendiente
      expect((await inspeccion(t.id, VEHICULO_2.id)).estado).toBe('pendiente');
      expect((await aprobar(t, VEHICULO.id)).status).toBe(409); // ya aprobada

      // el evento de Flota, cuando exista, no choca con la aprobación ya hecha
      await externos.consumir(
        externo(
          'flota.inspeccion_vehiculo.aprobada',
          { ticketId: t.id, vehiculoId: VEHICULO.id },
          'flota',
        ),
      );
      expect((await inspeccion(t.id, VEHICULO.id)).origen).toBe('manual_temporal');
    });
  });

  describe('Reporte Diario de Actividades (DYN-SGI-RE-047): borrador, completar, reabrir y día corregido por Facturación', () => {
    const FECHA = '2026-11-06';
    const actividad = (extra: object = {}) => ({
      horaInicio: '06:00',
      horaFin: '09:30',
      detalle: 'Armado de líneas y prueba de presión',
      ...extra,
    });
    const url = (t: { url: string }, fecha = FECHA) => `${t.url}/reportes-diarios/${fecha}`;
    const guardar = (t: { url: string }, cuerpo: object, h = op1(), fecha = FECHA) =>
      http().put(url(t, fecha)).set(h).send(cuerpo);
    const completar = (t: { url: string }, h = op1(), fecha = FECHA) =>
      http()
        .post(`${url(t, fecha)}/completar`)
        .set(h);
    const enEjecucion = async () => {
      const t = await ticketEnTraslado();
      await admin.query('UPDATE pumping.ticket SET paso_codigo = $2 WHERE id = $1', [
        t.id,
        'ejecucion_operativa',
      ]);
      return t;
    };
    const eventosDe = async (ticketId: string) =>
      (
        await admin.query(
          "SELECT datos FROM msg_operaciones.outbox WHERE tipo = 'operaciones.pumping.reporte_diario_completado' AND datos->'data'->>'ticketId' = $1 ORDER BY id",
          [ticketId],
        )
      ).rows.map((r) => r.datos.data);
    const corregido = (pedidoId: string, extra: Record<string, unknown> = {}): EventEnvelope => {
      const id = uuidv7();
      eventos.push(id);
      return {
        id,
        type: 'comercial.documento_operativo.corregido',
        version: 1,
        occurredAt: new Date().toISOString(),
        source: 'comercial',
        subject: { type: 'pedido', id: pedidoId },
        data: { pedidoId, documentoId: null, origen: 'pumping', fecha: FECHA, ...extra },
      } as EventEnvelope;
    };

    it('guarda el día como borrador, con la duración y las tablas de cada actividad calculadas y leídas del servidor', async () => {
      const t = await enEjecucion();
      const r = await guardar(t, {
        representanteCliente: 'Carlos Companyman',
        cargoRepresentante: 'Representante de Campo',
        tiempoProductivo: 7.5,
        tiempoNoProductivo: 1,
        observaciones: 'Sin novedades',
        actividades: [
          actividad({
            tablas: [
              {
                titulo: 'Volúmenes',
                columnas: ['Etapa', 'Bbl'],
                filas: [
                  ['1', '120'],
                  ['2', '135.5'],
                ],
              },
            ],
          }),
          actividad({ horaInicio: '22:00', horaFin: '02:00', detalle: 'Bombeo nocturno' }), // cruza la medianoche
        ],
      });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({
        fecha: FECHA,
        estado: 'borrador',
        representanteCliente: 'Carlos Companyman',
        tiempoProductivo: 7.5,
        totalHoras: 7.5, // 3,5 + 4
      });
      expect(r.body.actividades.map((a: { duracionHoras: number }) => a.duracionHoras)).toEqual([
        3.5, 4,
      ]);
      expect(r.body.actividades[0].tablas).toEqual([
        {
          titulo: 'Volúmenes',
          columnas: ['Etapa', 'Bbl'],
          filas: [
            ['1', '120'],
            ['2', '135.5'],
          ],
        },
      ]);
      expect(r.body.actividades[0].autor.id).toBe(OP1.id);

      // volver a guardar reemplaza el día
      const otra = await guardar(t, { actividades: [actividad({ detalle: 'Solo esta' })] });
      expect(otra.body.actividades).toHaveLength(1);
      const lista = await http().get(`${t.url}/reportes-diarios`).set(supervisora());
      expect(lista.body).toEqual([
        { fecha: FECHA, estado: 'borrador', actividades: 1, totalHoras: 3.5 },
      ]);
    });

    it('rechaza lo mal armado, a quien no es el Operador del equipo y fuera de su paso', async () => {
      const t = await enEjecucion();
      const malos: Array<[string, object]> = [
        ['hora mal escrita', { actividades: [actividad({ horaInicio: '6:00' })] }],
        ['mismas horas', { actividades: [actividad({ horaInicio: '08:00', horaFin: '08:00' })] }],
        ['detalle vacío', { actividades: [actividad({ detalle: '   ' })] }],
        [
          'fila con otra cantidad de celdas',
          { actividades: [actividad({ tablas: [{ columnas: ['A', 'B'], filas: [['1']] }] })] },
        ],
        [
          'tabla sin columnas',
          { actividades: [actividad({ tablas: [{ columnas: [], filas: [] }] })] },
        ],
        ['tiempo de más de 24 h', { actividades: [actividad()], tiempoProductivo: 25 }],
      ];
      for (const [caso, cuerpo] of malos) {
        const r = await guardar(t, cuerpo);
        expect({ caso, status: r.status }).toEqual({ caso, status: 400 });
      }
      expect((await guardar(t, { actividades: [actividad()] }, op1(), '2026-13-45')).status).toBe(
        400,
      );
      expect((await guardar(t, { actividades: [actividad()] }, operador())).status).toBe(403); // no es del equipo
      expect((await guardar(t, { actividades: [actividad()] }, supervisora())).status).toBe(403); // el paso es del Operador
      expect((await guardar(t, { actividades: [actividad()] })).status).toBe(200); // el operador del equipo sí

      // fuera de la Ejecución operativa
      await admin.query('UPDATE pumping.ticket SET paso_codigo = $2 WHERE id = $1', [
        t.id,
        'control_retorno',
      ]);
      expect((await guardar(t, { actividades: [actividad()] })).status).toBe(409);
    });

    it('completar exige actividades y publica el día para Comercial; editarlo lo reabre y se completa de nuevo', async () => {
      const t = await enEjecucion();
      expect((await completar(t)).status).toBe(404); // sin reporte guardado
      await guardar(t, { actividades: [] });
      const vacio = await completar(t);
      expect(vacio.status).toBe(400);
      expect(vacio.body.code).toBe('SIN_ACTIVIDADES');

      await guardar(t, {
        actividades: [
          actividad({ tablas: [{ titulo: 'Resumen', columnas: ['Dato'], filas: [['x']] }] }),
        ],
      });
      const ok = await completar(t);
      expect(ok.status).toBe(201);
      expect(ok.body.estado).toBe('completado');

      const [e1] = await eventosDe(t.id);
      expect(e1).toMatchObject({
        ticketId: t.id,
        pedidoId: t.pedidoId,
        fecha: FECHA,
        supervisorId: SUPERVISORA.id,
        operadorId: OP1.id,
        actividades: [
          {
            fecha: FECHA,
            horaInicio: '06:00',
            horaFin: '09:30',
            duracionHoras: 3.5,
            tablas: [{ titulo: 'Resumen', columnas: ['Dato'], filas: [['x']] }],
          },
        ],
      });

      // se puede reabrir aunque figure completado: guardar lo deja en borrador, y al completar se reenvía el día
      const reabierto = await guardar(t, {
        actividades: [actividad({ detalle: 'Corregido por el operador' })],
      });
      expect(reabierto.body.estado).toBe('borrador');
      await completar(t).expect(201);
      const eventos2 = await eventosDe(t.id);
      expect(eventos2).toHaveLength(2);
      expect(eventos2[1].actividades[0].detalle).toBe('Corregido por el operador');
    });

    it('si Facturación corrige el día (evento de Comercial), el ticket ya no lo edita ni lo reenvía; el evento es idempotente y solo cuenta el de Pumping', async () => {
      const t = await enEjecucion();
      await guardar(t, { actividades: [actividad()] });
      await completar(t).expect(201);

      const e = corregido(t.pedidoId);
      await diaCorregido.consumir(e);
      await diaCorregido.consumir(e); // mismo evento: lo ignora el inbox
      const r = await http().get(url(t)).set(op1());
      expect(r.body.estado).toBe('corregido');

      const editar = await guardar(t, { actividades: [actividad()] });
      expect(editar.status).toBe(409);
      expect(editar.body.code).toBe('DIA_CORREGIDO');
      expect((await completar(t)).status).toBe(409);
      expect((await eventosDe(t.id)).length).toBe(1); // no se reenvió

      // un día corregido por Facturación sin reporte en el ticket también queda bloqueado
      await diaCorregido.consumir(corregido(t.pedidoId, { fecha: '2026-11-07' }));
      expect((await guardar(t, { actividades: [actividad()] }, op1(), '2026-11-07')).status).toBe(
        409,
      );
      // lo de FCR no es de este módulo
      await diaCorregido.consumir(corregido(t.pedidoId, { origen: 'fcr', fecha: '2026-11-08' }));
      expect((await guardar(t, { actividades: [actividad()] }, op1(), '2026-11-08')).status).toBe(
        200,
      );
    });

    it('la base impide una actividad sin duración, un completado sin quién y tiempos fuera de 0 a 24 h', async () => {
      const t = await enEjecucion();
      await guardar(t, { actividades: [actividad()] });
      const rep = (
        await admin.query('SELECT id FROM pumping.reporte_diario WHERE ticket_id = $1', [t.id])
      ).rows[0].id;
      await expect(
        admin.query(
          "INSERT INTO pumping.reporte_diario_actividad (id, reporte_id, orden, hora_inicio, hora_fin, detalle, autor_id) VALUES ($1, $2, 9, '08:00', '08:00', 'x', $3)",
          [uuidv7(), rep, OP1.id],
        ),
      ).rejects.toThrow(/reporte_diario_actividad_horas_check/);
      await expect(
        admin.query('UPDATE pumping.reporte_diario SET completado_at = now() WHERE id = $1', [rep]),
      ).rejects.toThrow(/reporte_diario_completado_check/);
      await expect(
        admin.query('UPDATE pumping.reporte_diario SET tiempo_productivo = 30 WHERE id = $1', [
          rep,
        ]),
      ).rejects.toThrow(/reporte_diario_tiempos_check/);
      await expect(
        admin.query(
          "INSERT INTO pumping.reporte_diario_actividad (id, reporte_id, orden, hora_inicio, hora_fin, detalle, autor_id) VALUES ($1, $2, 0, '10:00', '11:00', 'x', $3)",
          [uuidv7(), rep, OP1.id],
        ),
      ).rejects.toThrow(/reporte_diario_actividad_orden_key/);
    });
  });

  describe('cambio de ítems del pedido: propone el Operador, aprueba el Supervisor y Comercial aplica (P7)', () => {
    const LISTA_A = uuidv7();
    const LISTA_B = uuidv7();
    const item = (listaPreciosItemId: string, extra: object = {}) => ({
      listaPreciosItemId,
      codigo: `COD-${listaPreciosItemId.slice(-4)}`,
      descripcion: 'Ítem de la lista del cliente',
      unidad: 'día',
      cantidad: 2,
      tipoLinea: 'servicio',
      ...extra,
    });
    const supervisoraAprueba = () =>
      como('supervisor', SUPERVISORA.id, SUPERVISORA.nombre, [
        P.PUMPING_OPERAR,
        P.PUMPING_CAMBIOS_APROBAR,
      ]);
    const op1Propone = () =>
      como('operador', OP1.id, OP1.nombre, [P.PUMPING_OPERAR, P.PUMPING_CAMBIOS_SOLICITAR]);
    const propone = (t: { url: string }, cuerpo: object, h = op1Propone()) =>
      http().post(`${t.url}/cambios-items`).set(h).send(cuerpo);
    const valido = () => ({
      motivo: 'Se usó más material del cotizado',
      items: [
        item(LISTA_A),
        item(LISTA_B, { tipoLinea: 'material', cantidad: 40.5, descuentoPct: 10 }),
      ],
    });
    const resultado = (
      solicitudId: string,
      aplicado: boolean,
      motivo: string | null = null,
    ): EventEnvelope => {
      const id = uuidv7();
      eventos.push(id);
      return {
        id,
        type: 'comercial.cambio_items.resultado',
        version: 1,
        occurredAt: new Date().toISOString(),
        source: 'comercial',
        subject: { type: 'pedido', id: uuidv7() },
        data: { solicitudId, pedidoId: uuidv7(), aplicado, motivo },
      } as EventEnvelope;
    };
    const eventosAprobados = async (ticketId: string) =>
      (
        await admin.query(
          "SELECT datos->'data' AS d FROM msg_operaciones.outbox WHERE tipo = 'operaciones.pumping.cambio_items_aprobado' AND datos->'data'->>'ticketId' = $1",
          [ticketId],
        )
      ).rows.map((r) => r.d);

    it('el equipo propone la lista de ítems, solo una pendiente por ticket y solo con lo que corresponde', async () => {
      const t = await ticketEnTraslado();
      const ok = await propone(t, valido());
      expect(ok.status).toBe(201);
      expect(ok.body).toMatchObject({
        estado: 'pendiente',
        motivo: 'Se usó más material del cotizado',
        aplicacion: null,
      });
      expect(ok.body.items).toHaveLength(2);
      expect(ok.body.items[1]).toMatchObject({
        cantidad: 40.5,
        descuentoPct: 10,
        tipoLinea: 'material',
      });

      const otra = await propone(t, valido());
      expect(otra.status).toBe(409);
      expect(otra.body.code).toBe('SOLICITUD_PENDIENTE');

      const n = await ticketEnTraslado();
      const malos: Array<[string, object]> = [
        ['sin motivo', { ...valido(), motivo: '  ' }],
        ['sin ítems', { ...valido(), items: [] }],
        ['ítem repetido', { ...valido(), items: [item(LISTA_A), item(LISTA_A)] }],
        ['cantidad cero', { ...valido(), items: [item(LISTA_A, { cantidad: 0 })] }],
        ['descuento de más', { ...valido(), items: [item(LISTA_A, { descuentoPct: 120 })] }],
        [
          'tipo de línea que no existe',
          { ...valido(), items: [item(LISTA_A, { tipoLinea: 'otro' })] },
        ],
      ];
      for (const [caso, cuerpo] of malos) {
        const r = await propone(n, cuerpo);
        expect({ caso, status: r.status }).toEqual({ caso, status: 400 });
      }
      // quien no es del equipo no propone; sin equipo asignado tampoco
      const ajeno = como('operador', OPERADOR_QUE_ACTUA, 'Oscar Operador', [
        P.PUMPING_OPERAR,
        P.PUMPING_CAMBIOS_SOLICITAR,
      ]);
      expect((await propone(n, valido(), ajeno)).status).toBe(403);
      const sinEquipo = await ticketEnAsignacion();
      expect((await propone(sinEquipo, valido())).status).toBe(409);
      expect((await propone(n, valido(), op1())).status).toBe(403); // sin el permiso de proponer
    });

    it('el Supervisor del ticket aprueba: la solicitud queda por aplicar y Comercial recibe el cambio; otro supervisor no puede', async () => {
      const t = await ticketEnTraslado();
      const sol = (await propone(t, valido())).body;
      const pend = await http().get(`${base}/cambios-items/pendientes`).set(supervisoraAprueba());
      expect(pend.body.map((x: { id: string }) => x.id)).toContain(sol.id);
      expect(pend.body.find((x: { id: string }) => x.id === sol.id).ticket).toMatchObject({
        id: t.id,
      });

      const otroSup = como('supervisor_pumping', SUPERVISOR_PUMPING.id, SUPERVISOR_PUMPING.nombre, [
        P.PUMPING_OPERAR,
        P.PUMPING_CAMBIOS_APROBAR,
      ]);
      expect(
        (await http().post(`${base}/cambios-items/${sol.id}/aprobar`).set(otroSup)).status,
      ).toBe(403);
      expect(
        (await http().post(`${base}/cambios-items/${sol.id}/aprobar`).set(op1Propone())).status,
      ).toBe(403);

      const ok = await http()
        .post(`${base}/cambios-items/${sol.id}/aprobar`)
        .set(supervisoraAprueba());
      expect(ok.status).toBe(201);
      expect(ok.body).toMatchObject({
        estado: 'aprobada',
        aplicacion: 'pendiente',
        revisadoPor: { id: SUPERVISORA.id },
      });
      const [e] = await eventosAprobados(t.id);
      expect(e).toMatchObject({ solicitudId: sol.id, pedidoId: t.pedidoId });
      expect(e.items).toEqual([
        { listaPreciosItemId: LISTA_A, cantidad: 2, tipoLinea: 'servicio' },
        { listaPreciosItemId: LISTA_B, cantidad: 40.5, descuentoPct: 10, tipoLinea: 'material' },
      ]);
      // ya revisada
      expect(
        (await http().post(`${base}/cambios-items/${sol.id}/aprobar`).set(supervisoraAprueba()))
          .status,
      ).toBe(409);
      expect(
        (
          await http()
            .post(`${base}/cambios-items/${sol.id}/rechazar`)
            .set(supervisoraAprueba())
            .send({})
        ).status,
      ).toBe(409);

      // la respuesta de Comercial queda en la solicitud (idempotente); el motivo solo cuando no se pudo aplicar
      const r1 = resultado(sol.id, true);
      await resultadoCambio.consumir(r1);
      await resultadoCambio.consumir(r1);
      await resultadoCambio.consumir(resultado(sol.id, false, 'otra respuesta tardía')); // ya cerrada: no cambia
      const lista = await http().get(`${t.url}/cambios-items`).set(supervisoraAprueba());
      expect(lista.body[0]).toMatchObject({
        estado: 'aprobada',
        aplicacion: 'aplicada',
        aplicacionMotivo: null,
      });
    });

    it('si Comercial no pudo aplicarlo, la solicitud dice por qué; rechazar deja el motivo y libera para proponer otra', async () => {
      const t = await ticketEnTraslado();
      const a = (await propone(t, valido())).body;
      await http()
        .post(`${base}/cambios-items/${a.id}/aprobar`)
        .set(supervisoraAprueba())
        .expect(201);
      await resultadoCambio.consumir(
        resultado(a.id, false, 'El pedido ya salió al cliente para firmas'),
      );
      const tras = (await http().get(`${t.url}/cambios-items`).set(supervisoraAprueba())).body[0];
      expect(tras).toMatchObject({
        aplicacion: 'no_aplicada',
        aplicacionMotivo: 'El pedido ya salió al cliente para firmas',
      });

      const b = (await propone(t, valido())).body; // la anterior ya no está pendiente
      const rech = await http()
        .post(`${base}/cambios-items/${b.id}/rechazar`)
        .set(supervisoraAprueba())
        .send({ motivo: 'No coincide con el reporte' });
      expect(rech.status).toBe(201);
      expect(rech.body).toMatchObject({
        estado: 'rechazada',
        motivoRechazo: 'No coincide con el reporte',
        aplicacion: null,
      });
      expect((await eventosAprobados(t.id)).length).toBe(1); // rechazar no publica nada hacia Comercial
    });

    it('la base mantiene la coherencia: aprobada con resultado, una pendiente por ticket y lo propuesto no se cambia', async () => {
      const t = await ticketEnTraslado();
      const sol = (await propone(t, valido())).body;
      await expect(
        admin.query(
          "UPDATE pumping.solicitud_cambio_items SET estado = 'aprobada', revisado_por = $2, revisado_at = now() WHERE id = $1",
          [sol.id, SUPERVISORA.id],
        ),
      ).rejects.toThrow(/solicitud_cambio_items_aplicacion_check/);
      await expect(
        admin.query(
          "UPDATE pumping.solicitud_cambio_items SET motivo_rechazo = 'x' WHERE id = $1",
          [sol.id],
        ),
      ).rejects.toThrow(/solicitud_cambio_items_rechazo_check/);
      await expect(
        admin.query(
          "INSERT INTO pumping.solicitud_cambio_items (id, ticket_id, motivo, solicitado_por) VALUES ($1, $2, 'otra', $3)",
          [uuidv7(), t.id, OP1.id],
        ),
      ).rejects.toThrow(/solicitud_cambio_items_pendiente_key/);
      const app = new Pool({ connectionString: APP_DB.replace('?pgbouncer=true', ''), max: 1 });
      try {
        await expect(
          app.query('UPDATE pumping.solicitud_cambio_item SET cantidad = 99'),
        ).rejects.toThrow(/permission denied/);
        await expect(app.query('DELETE FROM pumping.solicitud_cambio_item')).rejects.toThrow(
          /permission denied/,
        );
      } finally {
        await app.end();
      }
    });
  });

  describe('documentos del ticket: el monitoreo de cada día de operación', () => {
    const subirArchivo = async () => {
      const id = uuidv7();
      await admin.query(
        `INSERT INTO archivos.archivo (id, modulo_id, nombre_original, mime_type, tamano_bytes, sha256, blob_key, escaneo, subido_por)
         SELECT $1::uuid, mo.id, 'mezcla.pdf', 'application/pdf', 10, repeat('c', 64), 'prueba/' || $1::text, 'omitido', $2::uuid
           FROM archivos.modulo_archivo mo WHERE mo.codigo = 'pedido_documento'`,
        [id, JEFE],
      );
      return id;
    };
    const adjuntar = (t: { url: string }, cuerpo: object, h = op1()) =>
      http().post(`${t.url}/documentos/monitoreo`).set(h).send(cuerpo);
    const enEjecucion = async () => {
      const t = await ticketEnTraslado();
      await admin.query('UPDATE pumping.ticket SET paso_codigo = $2 WHERE id = $1', [
        t.id,
        'ejecucion_operativa',
      ]);
      return t;
    };

    it('el Operador del equipo adjunta el monitoreo de un día; hay varios por día y todos quedan como historia', async () => {
      const t = await enEjecucion();
      const a = await subirArchivo();
      const b = await subirArchivo();
      const r1 = await adjuntar(t, { fecha: '2026-11-06', archivoId: a });
      expect(r1.status).toBe(201);
      expect(r1.body).toEqual([
        expect.objectContaining({ tipo: 'monitoreo', fecha: '2026-11-06', archivoId: a }),
      ]);
      const r2 = await adjuntar(t, { fecha: '2026-11-06', archivoId: b });
      expect(r2.body.map((d: { archivoId: string }) => d.archivoId)).toEqual([a, b]);
      const lista = await http().get(`${t.url}/documentos`).set(supervisora());
      expect(lista.status).toBe(200);
      expect(lista.body).toHaveLength(2);
    });

    it('solo en su paso, por el Operador del equipo, con un archivo que existe y una fecha válida', async () => {
      const t = await ticketEnTraslado();
      const a = await subirArchivo();
      expect((await adjuntar(t, { fecha: '2026-11-06', archivoId: a })).status).toBe(409); // aún no está en ejecución
      await admin.query('UPDATE pumping.ticket SET paso_codigo = $2 WHERE id = $1', [
        t.id,
        'ejecucion_operativa',
      ]);
      expect((await adjuntar(t, { fecha: '2026-11-06', archivoId: a }, operador())).status).toBe(
        403,
      ); // no es del equipo
      expect((await adjuntar(t, { fecha: '2026-11-06', archivoId: a }, supervisora())).status).toBe(
        403,
      ); // el paso es del Operador
      expect((await adjuntar(t, { fecha: '2026-11-06', archivoId: uuidv7() })).status).toBe(400);
      expect((await adjuntar(t, { fecha: '06/11/2026', archivoId: a })).status).toBe(400);
      expect((await adjuntar(t, { fecha: '2026-02-31', archivoId: a })).status).toBe(400);
      expect((await http().get(`${t.url}/documentos`).set(sinPermiso())).status).toBe(403);
    });

    it('la base exige la fecha en el monitoreo y la prohíbe en los demás documentos', async () => {
      const t = await enEjecucion();
      const a = await subirArchivo();
      const insertar = (tipo: string, fecha: string | null) =>
        admin.query(
          'INSERT INTO pumping.ticket_documento (id, ticket_id, tipo, fecha, archivo_id, created_by) VALUES ($1, $2, $3::pumping.tipo_documento_ticket, $4, $5, $6)',
          [uuidv7(), t.id, tipo, fecha, a, JEFE],
        );
      await expect(insertar('monitoreo', null)).rejects.toThrow(/ticket_documento_fecha_check/);
      await expect(insertar('mezcla_quimica', '2026-11-06')).rejects.toThrow(
        /ticket_documento_fecha_check/,
      );
      await insertar('monitoreo', '2026-11-06');
    });
  });
});
