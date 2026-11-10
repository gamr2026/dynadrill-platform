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
import { DuracionResultadoConsumer } from './consumers/duracion-resultado.consumer';
import { AvanceService } from './services/avance.service';
import { ResultadoCambioItemsConsumer } from './consumers/resultado-cambio-items.consumer';
import { PedidosAbiertosConsumer } from './consumers/pedidos-abiertos.consumer';
import { RequisitosExternosConsumer } from './consumers/requisitos-externos.consumer';
import { hashTexto } from './catalog/sembrar-traslado-salida';
import { PumpingModule } from './pumping.module';
import { AsignacionService } from './services/asignacion.service';
import { JornadasAvisosService } from './services/jornadas-avisos.service';
import { JornadasService } from './services/jornadas.service';
import { PrismaService } from './prisma/prisma.service';
import { idsDeUnidades } from './testing/unidades';
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
const CONDUCTORES = [
  { id: uuidv7(), nombre: 'Carlos Conductor' },
  { id: uuidv7(), nombre: 'Clara Conductora' },
];
const SUPERVISOR_PUMPING = { id: uuidv7(), nombre: 'Pablo Supervisor Pumping' };
const SIN_ROL_OPERADOR = { id: uuidv7(), nombre: 'Vera Ventas Real' };
const COMPANY_MAN = { id: uuidv7(), nombre: `Ing. Company Man IT ${Date.now()}` };
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
// Pumping asigna unidades de Flota (D2): cada vehículo de prueba del catálogo tiene su unidad enlazada (`flota.unidad.vehiculo_id`)
const VEHICULO = {
  id: uuidv7(),
  placa: `IT${String(n).slice(-5)}P`,
  unidadId: uuidv7(),
  unidadCodigo: `IT-UP-${n}`,
};
const VEHICULO_2 = {
  id: uuidv7(),
  placa: `IT${String(n).slice(-5)}Q`,
  unidadId: uuidv7(),
  unidadCodigo: `IT-UQ-${n}`,
};
/** Unidades de Flota sin vehículo del catálogo y una inactiva: para lo que la asignación debe aceptar y rechazar. */
const UNIDAD_SIN_VEHICULO = { id: uuidv7(), codigo: `IT-US-${n}` };
const UNIDAD_INACTIVA = { id: uuidv7(), codigo: `IT-UI-${n}` };
const BODEGA = { id: uuidv7(), nombre: `BODEGA-PU ${n}` };
const MAESTROS: MaestrosDePrueba = {
  usuarios: [
    { id: JEFE, nombre: 'Jaime Jefe de Base', rol: 'jefe_base' },
    { id: OPERADOR_QUE_ACTUA, nombre: 'Oscar Operador', rol: 'operador' },
    { id: SUPERVISORA.id, nombre: SUPERVISORA.nombre, rol: 'supervisor' },
    { id: SUPERVISOR_PUMPING.id, nombre: SUPERVISOR_PUMPING.nombre, rol: 'supervisor_pumping' },
    ...OPERADORES.map((o) => ({ id: o.id, nombre: o.nombre, rol: 'operador' })),
    ...CONDUCTORES.map((c) => ({ id: c.id, nombre: c.nombre, rol: 'conductor' })),
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
  /** Id de una unidad del catálogo por su nombre. */
  let U: (nombre: string) => string;
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
  // quien valida queda registrado: debe ser una cuenta real (FK a identidad.usuario)
  const qhse = () =>
    token('gerente_hse', 'Gloria HSE', [P.PUMPING_TERMINOS_VALIDAR], SUPERVISORA.id);

  const pedidos: string[] = [];
  const eventos: string[] = [];
  /** Números de ticket de prueba (únicos): en producción los reserva `comercial` del secuencial de la prefactura. */
  let ticketSeq = 800_000 + (n % 100_000) * 10;
  let diaSeq = 0;

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
        representanteCampoId: COMPANY_MAN.id,
        fechaInicioServicio: '2026-11-05',
        as2Numero: null,
        ...extra.data,
      },
      ...(extra.id ? {} : {}),
    } as EventEnvelope;
  };

  beforeAll(async () => {
    await sembrarMaestros(admin, MAESTROS);
    for (const v of [VEHICULO, VEHICULO_2]) {
      await admin.query(
        `INSERT INTO flota.unidad (id, codigo, nombre, tipo, vehiculo_id, predeterminada, activa)
         VALUES ($1, $2, $3, 'servicio', $4, false, true)`,
        [v.unidadId, v.unidadCodigo, `Unidad de prueba ${v.placa}`, v.id],
      );
    }
    for (const [u, activa] of [
      [UNIDAD_SIN_VEHICULO, true],
      [UNIDAD_INACTIVA, false],
    ] as const) {
      await admin.query(
        `INSERT INTO flota.unidad (id, codigo, nombre, tipo, predeterminada, activa)
         VALUES ($1, $2, $3, 'servicio', false, $4)`,
        [u.id, u.codigo, `Unidad de prueba ${u.codigo}`, activa],
      );
    }
    await admin.query(
      "INSERT INTO catalogos.persona_contacto (id, tipo, nombre) VALUES ($1, 'representante_campo', $2)",
      [COMPANY_MAN.id, COMPANY_MAN.nombre],
    );
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
    jest
      .spyOn(DuracionResultadoConsumer.prototype, 'onApplicationBootstrap')
      .mockResolvedValue(undefined);
    await app.init();
    prisma = app.get(PrismaService);
    U = await idsDeUnidades(prisma);
    consumer = app.get(PedidosAbiertosConsumer);
    externos = app.get(RequisitosExternosConsumer);
    diaCorregido = app.get(DiaCorregidoConsumer);
    resultadoCambio = app.get(ResultadoCambioItemsConsumer);
    // el día de las pruebas es fijo: sus fechas (5 al 7 de noviembre) no dependen del día en que se corran
    jest.spyOn(app.get(AsignacionService), 'hoy').mockReturnValue('2026-11-05');
    jest.spyOn(app.get(JornadasService), 'hoy').mockReturnValue('2026-11-05');
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
    if (pedidos.length) {
      // lo reportado de una línea no se borra en cascada (historia): se quita primero
      await admin.query(
        'DELETE FROM pumping.reporte_item_dia WHERE linea_id IN (SELECT l.id FROM pumping.ticket_linea l JOIN pumping.ticket t ON t.id = l.ticket_id WHERE t.pedido_id = ANY($1::uuid[]))',
        [pedidos],
      );
      await admin.query('DELETE FROM pumping.ticket WHERE pedido_id = ANY($1::uuid[])', [pedidos]);
    }
    await admin.query('DELETE FROM flota.unidad WHERE id = ANY($1::uuid[])', [
      [VEHICULO.unidadId, VEHICULO_2.unidadId, UNIDAD_SIN_VEHICULO.id, UNIDAD_INACTIVA.id],
    ]);
    await admin.query('DELETE FROM catalogos.persona_contacto WHERE id = $1', [COMPANY_MAN.id]);
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
    await admin.query(
      "DELETE FROM msg_operaciones.outbox WHERE tipo = 'operaciones.pumping.terminos_aceptados' AND datos->'data'->>'usuarioId' = ANY($1::text[])",
      [[OP1.id, OP2.id]],
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
    // el Company Man del pedido llega al ticket (solo el id; el nombre sale del catálogo)
    expect(t.representanteCampoId).toBe(COMPANY_MAN.id);
    const detalle = await http()
      .get(`/api/operaciones/pumping/tickets/${t.id}`)
      .set(jefe())
      .expect(200);
    expect(detalle.body.representanteCampo).toEqual({
      id: COMPANY_MAN.id,
      nombre: COMPANY_MAN.nombre,
    });
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
  const CO1 = CONDUCTORES[0];
  const CO2 = CONDUCTORES[1];
  const como = (
    roleCode: string,
    id: string,
    nombre: string,
    permisos: string[] = [P.PUMPING_OPERAR],
  ) => token(roleCode, nombre, permisos, id);
  const op1 = () => como('operador', OP1.id, OP1.nombre);
  const op2 = () => como('operador', OP2.id, OP2.nombre);
  const supervisora = () => como('supervisor', SUPERVISORA.id, SUPERVISORA.nombre);
  const cuerpoAsignacion = {
    supervisorId: SUPERVISORA.id,
    operadores: [
      { usuarioId: OP1.id, unidadId: VEHICULO.unidadId },
      { usuarioId: OP2.id, unidadId: VEHICULO_2.unidadId },
    ],
    conductores: [
      { usuarioId: CO1.id, unidadId: VEHICULO.unidadId },
      { usuarioId: CO2.id, unidadId: VEHICULO_2.unidadId },
    ],
  };
  const base = '/api/operaciones/pumping';

  /** Ticket nuevo, pasado a Asignación (listo para asignar). */
  const ticketEnAsignacion = async () => {
    const e = evento();
    await consumer.consumir(e);
    const t = await prisma.ticket.findUniqueOrThrow({ where: { pedidoId: e.subject.id } });
    // cada ticket de prueba tiene su propio día de servicio: el personal no se asigna a dos tickets abiertos que se cruzan
    const dia = new Date(Date.UTC(2027, 0, 1 + diaSeq++));
    await prisma.ticket.update({
      where: { id: t.id },
      data: { fechaInicioServicio: dia, fechaFinServicio: dia },
    });
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
        include: { unidad: { include: { vehiculo: true } }, usuario: true },
      })
    ).map((r) => ({
      codigo: r.requisitoCodigo,
      estado: r.estado,
      origen: r.origen,
      para: r.unidad ? (r.unidad.vehiculo?.placa ?? r.unidad.codigo) : (r.usuario?.nombre ?? null),
      id: r.id,
    }));
  /** Cumple lo que exige el traslado de salida salvo el reporte de unidad: términos, EPI e inspección de vehículos (el checklist de ingreso es de la ejecución). */
  const cumplirTodoMenosReporte = async (id: string) => {
    for (const o of [op1(), op2()])
      await http().post(`${base}/tickets/${id}/terminos/aceptar`).set(o).expect(201);
    for (const o of [OP1, OP2])
      await externos.consumir(externo('qhse.epi.despachada', { ticketId: id, usuarioId: o.id }));
    // (la inspección, el reporte de unidad y el gerenciamiento de viaje ya no son del paso: son de cada jornada)
    // QHSE abrió el PTW del primer día de operación (y no hay SWA activa: ese requisito nace cumplido)
    await externos.consumir(
      externo('qhse.ptw.abierto', { ticketId: id, ...(await diaInicio(id)) }),
    );
  };
  /** El primer día de operación del ticket (lo que trae el PTW en `diaOperacion`). */
  const diaInicio = async (id: string) => {
    const t = await prisma.ticket.findUniqueOrThrow({ where: { id } });
    return t.fechaInicioServicio
      ? { diaOperacion: t.fechaInicioServicio.toISOString().slice(0, 10) }
      : {};
  };
  const salidaValida = async (id: string, unidadId: string) => {
    const r = (
      await http()
        .get(`${base}/tickets/${id}/reportes-unidad/${unidadId}`)
        .set(supervisora())
        .expect(200)
    ).body;
    return {
      fecha: '2026-11-05',
      combustible: 80.5,
      origen: 'Base Coco',
      destino: 'Pozo Beta-9',
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
        operadores: [{ usuarioId: SUPERVISORA.id, unidadId: VEHICULO.unidadId }],
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
      .send({ ...cuerpoAsignacion, operadores: [{ usuarioId: OP1.id, unidadId: uuidv7() }] })
      .expect(400); // unidad inexistente
    await http()
      .post(url)
      .set(jefe())
      .send({
        ...cuerpoAsignacion,
        operadores: [{ usuarioId: SIN_ROL_OPERADOR.id, unidadId: VEHICULO.unidadId }],
      })
      .expect(400); // no es operador
    await http()
      .post(url)
      .set(jefe())
      .send({
        ...cuerpoAsignacion,
        supervisorId: OP1.id,
        operadores: [{ usuarioId: OP2.id, unidadId: VEHICULO.unidadId }],
      })
      .expect(400); // un operador no es supervisor

    await http()
      .post(url)
      .set(jefe())
      .send({ ...cuerpoAsignacion, conductores: [] })
      .expect(400); // sin conductores
    await http()
      .post(url)
      .set(jefe())
      .send({ ...cuerpoAsignacion, conductores: [cuerpoAsignacion.conductores[0]] })
      .expect(400); // la segunda unidad no tiene conductor
    await http()
      .post(url)
      .set(jefe())
      .send({
        ...cuerpoAsignacion,
        conductores: [
          cuerpoAsignacion.conductores[0],
          { usuarioId: SIN_ROL_OPERADOR.id, unidadId: VEHICULO_2.unidadId },
        ],
      })
      .expect(400); // no es conductor

    const r = await http().post(url).set(jefe()).send(cuerpoAsignacion).expect(201);
    expect(r.body.paso).toMatchObject({ codigo: 'traslado_salida' });
    expect(r.body.asignacion.conductores).toEqual([
      {
        usuarioId: CO1.id,
        nombre: CO1.nombre,
        unidadId: VEHICULO.unidadId,
        codigo: VEHICULO.unidadCodigo,
        placa: VEHICULO.placa,
      },
      {
        usuarioId: CO2.id,
        nombre: CO2.nombre,
        unidadId: VEHICULO_2.unidadId,
        codigo: VEHICULO_2.unidadCodigo,
        placa: VEHICULO_2.placa,
      },
    ]);
    expect(r.body.asignacion.supervisor).toEqual({
      usuarioId: SUPERVISORA.id,
      nombre: SUPERVISORA.nombre,
    });
    expect(r.body.asignacion.operadores).toEqual([
      {
        usuarioId: OP2.id,
        nombre: OP2.nombre,
        unidadId: VEHICULO_2.unidadId,
        codigo: VEHICULO_2.unidadCodigo,
        placa: VEHICULO_2.placa,
      },
      {
        usuarioId: OP1.id,
        nombre: OP1.nombre,
        unidadId: VEHICULO.unidadId,
        codigo: VEHICULO.unidadCodigo,
        placa: VEHICULO.placa,
      },
    ]);
    expect(r.body.asignacion.unidades.map((u: { placa: string }) => u.placa).sort()).toEqual(
      [VEHICULO.placa, VEHICULO_2.placa].sort(),
    );
    // lo que el proceso exige una sola vez: del ticket 4 (acta de entrega, SWA, PTW del primer día y reporte de herramientas) y 2 por operador (EPI y términos). Lo de cada día (checklist, Company Man, inspección, reporte de unidad y gerenciamiento de viaje por unidad) es de cada jornada
    const req = await requisitosDe(t.id);
    expect(req).toHaveLength(4 + 2 * 2);
    for (const viejo of [
      'inspeccion_vehiculo_realizada',
      'inspeccion_vehiculo_aprobada',
      'reporte_unidad_salida',
      'reporte_unidad_llegada',
      'gerenciamiento_viaje_salida_aprobado',
      'gerenciamiento_viaje_retorno_aprobado',
    ])
      expect(req.map((x) => x.codigo)).not.toContain(viejo);
    expect(req.map((x) => x.codigo)).not.toContain('checklist_ingreso_locacion');
    expect(req.map((x) => x.codigo)).not.toContain('ejecucion_formalizada');
    expect(
      req.filter((x) => x.codigo !== 'swa_sin_activar').every((x) => x.estado === 'pendiente'),
    ).toBe(true);
    // sin SWA activa nace cumplido; solo un aviso de QHSE lo reabre
    expect(req.find((x) => x.codigo === 'swa_sin_activar')).toMatchObject({
      estado: 'cumplido',
      origen: 'sistema',
    });
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
        { usuarioId: CO1.id, rolCodigo: 'conductor' },
        { usuarioId: CO2.id, rolCodigo: 'conductor' },
      ].sort((a, b) => 0 * (a.usuarioId < b.usuarioId ? -1 : 1)),
    );
    // el conductor de cada unidad es el responsable de su inspección (Flota abre el caso a su nombre)
    expect(d.conductoresUnidades).toEqual(
      expect.arrayContaining([
        { usuarioId: CO1.id, unidadId: VEHICULO.unidadId, vehiculoId: VEHICULO.id },
        { usuarioId: CO2.id, unidadId: VEHICULO_2.unidadId, vehiculoId: VEHICULO_2.id },
      ]),
    );
    expect(d.operadoresUnidades).toEqual(
      expect.arrayContaining([
        { usuarioId: OP1.id, unidadId: VEHICULO.unidadId, vehiculoId: VEHICULO.id },
        { usuarioId: OP2.id, unidadId: VEHICULO_2.unidadId, vehiculoId: VEHICULO_2.id },
      ]),
    );
  });

  it('D2: solo se asignan unidades de Flota activas; una sin vehículo se nombra por su código; el evento lleva la unidad y el vehículo enlazado (o nulo)', async () => {
    const t = await ticketEnAsignacion();
    const url = `${t.url}/asignar`;
    const con = (unidadId: string) => ({
      supervisorId: SUPERVISORA.id,
      operadores: [{ usuarioId: OP1.id, unidadId }],
      conductores: [{ usuarioId: CO1.id, unidadId }],
    });
    // una unidad inactiva no se asigna, y el id de un vehículo del catálogo ya no es una unidad
    const inactiva = await http().post(url).set(jefe()).send(con(UNIDAD_INACTIVA.id)).expect(400);
    expect(inactiva.body.detail ?? inactiva.body.message).toMatch(
      /no existe o no está activa en Flota/,
    );
    await http().post(url).set(jefe()).send(con(VEHICULO.id)).expect(400);
    await http().post(url).set(jefe()).send(con(uuidv7())).expect(400);
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).pasoCodigo).toBe(
      'asignacion',
    );
    expect(await prisma.ticketUnidad.count({ where: { ticketId: t.id } })).toBe(0);

    // una unidad de Flota sin vehículo del catálogo sí se asigna: sin placa, se nombra por su código
    const r = await http().post(url).set(jefe()).send(con(UNIDAD_SIN_VEHICULO.id)).expect(201);
    expect(r.body.asignacion.unidades).toEqual([
      {
        unidadId: UNIDAD_SIN_VEHICULO.id,
        codigo: UNIDAD_SIN_VEHICULO.codigo,
        nombre: `Unidad de prueba ${UNIDAD_SIN_VEHICULO.codigo}`,
        placa: null,
        descripcion: `Unidad de prueba ${UNIDAD_SIN_VEHICULO.codigo}`,
      },
    ]);
    expect(r.body.asignacion.operadores).toEqual([
      expect.objectContaining({ unidadId: UNIDAD_SIN_VEHICULO.id, placa: null }),
    ]);
    // los traslados de cada día se exigen en cada jornada, no como requisitos del ticket
    const req = await requisitosDe(t.id);
    expect(req.some((x) => x.para === UNIDAD_SIN_VEHICULO.codigo)).toBe(false);
    const evento = (
      await admin.query(
        "SELECT datos->'data' AS d FROM msg_operaciones.outbox WHERE tipo = 'operaciones.pumping.asignacion_realizada' AND datos->'data'->>'pedidoId' = $1",
        [t.pedidoId],
      )
    ).rows[0].d;
    expect(evento.operadoresUnidades).toEqual([
      { usuarioId: OP1.id, unidadId: UNIDAD_SIN_VEHICULO.id, vehiculoId: null },
    ]);
    expect(evento.conductoresUnidades).toEqual([
      { usuarioId: CO1.id, unidadId: UNIDAD_SIN_VEHICULO.id, vehiculoId: null },
    ]);
    expect(evento.unidades).toBe(UNIDAD_SIN_VEHICULO.codigo);
    expect(evento.operadores).toBe(`${OP1.nombre} (${UNIDAD_SIN_VEHICULO.codigo})`);
  });

  it('D2: las reglas de la base sobre la unidad: FK a Flota, la unidad solo donde está asignada al ticket y una sola vez', async () => {
    const t = await ticketEnTraslado();
    const otro = await ticketEnAsignacion(); // sin unidades asignadas
    const intenta = (sql: string, params: unknown[], patron: RegExp) =>
      expect(admin.query(sql, params)).rejects.toThrow(patron);

    // una unidad que no existe en Flota
    await intenta(
      'INSERT INTO pumping.ticket_unidad (ticket_id, unidad_id) VALUES ($1, $2)',
      [otro.id, uuidv7()],
      /ticket_unidad_unidad_id_fkey/,
    );
    // la misma unidad dos veces en el ticket
    await intenta(
      'INSERT INTO pumping.ticket_unidad (ticket_id, unidad_id) VALUES ($1, $2)',
      [t.id, VEHICULO.unidadId],
      /ticket_unidad_pkey/,
    );
    // una persona, un requisito o un reporte con una unidad que NO está asignada a ese ticket
    await intenta(
      "INSERT INTO pumping.ticket_persona (ticket_id, usuario_id, rol, unidad_id) VALUES ($1, $2, 'operador', $3)",
      [otro.id, OP1.id, VEHICULO.unidadId],
      /ticket_persona_unidad_fkey/,
    );
    await intenta(
      "INSERT INTO pumping.ticket_requisito (id, ticket_id, requisito_codigo, unidad_id) VALUES ($1, $2, 'reporte_unidad_salida', $3)",
      [uuidv7(), otro.id, VEHICULO.unidadId],
      /ticket_requisito_unidad_fkey/,
    );
    await intenta(
      'INSERT INTO pumping.reporte_unidad (id, ticket_id, unidad_id) VALUES ($1, $2, $3)',
      [uuidv7(), otro.id, VEHICULO.unidadId],
      /reporte_unidad_unidad_fkey/,
    );
    // un requisito es de una unidad o de un operador, no de ambos
    await intenta(
      "INSERT INTO pumping.ticket_requisito (id, ticket_id, requisito_codigo, unidad_id, usuario_id) VALUES ($1, $2, 'reporte_unidad_salida', $3, $4)",
      [uuidv7(), t.id, VEHICULO.unidadId, OP1.id],
      /ticket_requisito_ambito_check|ticket_requisito_unico_key/,
    );
    // un reporte por ticket y unidad
    await admin.query(
      'INSERT INTO pumping.reporte_unidad (id, ticket_id, unidad_id) VALUES ($1, $2, $3)',
      [uuidv7(), t.id, VEHICULO.unidadId],
    );
    await intenta(
      'INSERT INTO pumping.reporte_unidad (id, ticket_id, unidad_id) VALUES ($1, $2, $3)',
      [uuidv7(), t.id, VEHICULO.unidadId],
      /reporte_unidad_ticket_unidad_fecha_key/,
    );
    // una unidad en uso por un ticket no se borra de Flota
    await intenta(
      'DELETE FROM flota.unidad WHERE id = $1',
      [VEHICULO.unidadId],
      /ticket_unidad_unidad_id_fkey/,
    );
    // y ya no existe el vehículo del catálogo como columna de estas tablas
    const columnas = await admin.query(
      "SELECT table_name FROM information_schema.columns WHERE table_schema = 'pumping' AND column_name = 'vehiculo_id'",
    );
    expect(columnas.rows).toEqual([]);
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
    expect(await prisma.ticketPersona.count({ where: { ticketId: t.id } })).toBe(5); // supervisor, 2 operadores y 2 conductores
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

  it('disponibilidad del personal: quien está en otro ticket sin cerrar con fechas que se cruzan no se puede asignar; se libera el día de fin del servicio o al cerrar', async () => {
    const dia = (n: number) => new Date(Date.UTC(2028, 0, 1 + n));
    const ventana = (id: string, ini: Date, fin: Date) =>
      prisma.ticket.update({
        where: { id },
        data: { fechaInicioServicio: ini, fechaFinServicio: fin },
      });
    // la base trae tickets reales con su propio personal: aquí solo importa el de esta prueba
    const equipo = [SUPERVISORA.id, OP1.id, OP2.id, CO1.id, CO2.id, SUPERVISOR_PUMPING.id];
    const ocupados = async (id: string) =>
      (
        (await http().get(`${base}/tickets/${id}/personal-ocupado`).set(jefe()).expect(200))
          .body as { usuarioId: string; ticketNumero: number | null; liberaEl: string | null }[]
      ).filter((o) => equipo.includes(o.usuarioId));

    const a = await ticketEnAsignacion();
    await ventana(a.id, dia(0), dia(2));
    await http().post(`${a.url}/asignar`).set(jefe()).send(cuerpoAsignacion).expect(201);
    const numeroA = (await prisma.ticket.findUniqueOrThrow({ where: { id: a.id } })).ticketNumero;

    // otro ticket que se cruza (empieza el último día de A): nadie del equipo está disponible, y la asignación lo rechaza
    const b = await ticketEnAsignacion();
    await ventana(b.id, dia(2), dia(4));
    const lista = await ocupados(b.id);
    expect(lista.map((o) => o.usuarioId).sort()).toEqual(
      [SUPERVISORA.id, OP1.id, OP2.id, CO1.id, CO2.id].sort(),
    );
    expect(lista[0]).toMatchObject({ ticketNumero: numeroA, liberaEl: '2028-01-03' });
    const rechazo = await http()
      .post(`${b.url}/asignar`)
      .set(jefe())
      .send(cuerpoAsignacion)
      .expect(409);
    expect(rechazo.body.code).toBe('PERSONAL_OCUPADO');
    // un solo integrante ocupado basta para rechazar
    await http()
      .post(`${b.url}/asignar`)
      .set(jefe())
      .send({
        ...cuerpoAsignacion,
        supervisorId: SUPERVISOR_PUMPING.id,
        operadores: [{ usuarioId: OP1.id, unidadId: VEHICULO.unidadId }],
        conductores: [{ usuarioId: CO1.id, unidadId: VEHICULO.unidadId }],
      })
      .expect(409);

    // al día siguiente del fin de A, el equipo ya está libre
    await ventana(b.id, dia(3), dia(4));
    expect(await ocupados(b.id)).toEqual([]);
    await http().post(`${b.url}/asignar`).set(jefe()).send(cuerpoAsignacion).expect(201);

    // un ticket cerrado libera al personal aunque sus fechas se crucen
    const c = await ticketEnAsignacion();
    await ventana(c.id, dia(3), dia(4));
    expect((await ocupados(c.id)).length).toBe(5); // B los tiene
    await prisma.ticket.update({ where: { id: b.id }, data: { pasoCodigo: 'cierre' } });
    expect(await ocupados(c.id)).toEqual([]);
    await http().post(`${c.url}/asignar`).set(jefe()).send(cuerpoAsignacion).expect(201);
    // sin permiso no se consulta
    await http().get(`${base}/tickets/${c.id}/personal-ocupado`).set(sinPermiso()).expect(403);
  });

  it('lo firmado con la asignación (términos aceptados, reporte de unidad) no se borra al reasignar ni en cascada (auditoría de la base)', async () => {
    const t = await ticketEnTraslado();
    const version = (await admin.query('SELECT codigo FROM pumping.terminos_version LIMIT 1'))
      .rows[0].codigo;
    await admin.query(
      'INSERT INTO pumping.aceptacion_terminos (id, ticket_id, usuario_id, version_codigo) VALUES ($1, $2, $3, $4)',
      [uuidv7(), t.id, OP1.id, version],
    );
    try {
      // (los requisitos del ticket ya impedían borrar a la persona asignada; se quitan para probar solo la regla de los términos)
      await admin.query('DELETE FROM pumping.ticket_requisito WHERE ticket_id = $1', [t.id]);
      // la base no deja borrar a la persona que ya aceptó los términos
      await expect(
        admin.query('DELETE FROM pumping.ticket_persona WHERE ticket_id = $1 AND usuario_id = $2', [
          t.id,
          OP1.id,
        ]),
      ).rejects.toThrow(/aceptacion_terminos_persona_fkey/);
      // y si el ticket vuelve a Asignación, reasignar se rechaza antes de tocar nada
      await admin.query("UPDATE pumping.ticket SET paso_codigo = 'asignacion' WHERE id = $1", [
        t.id,
      ]);
      const r = await http()
        .post(`${t.url}/asignar`)
        .set(jefe())
        .send(cuerpoAsignacion)
        .expect(409);
      expect(r.body.code).toBe('ASIGNACION_CON_REGISTROS');
      const quedan = await admin.query(
        'SELECT count(*)::int n FROM pumping.ticket_persona WHERE ticket_id = $1',
        [t.id],
      );
      expect(quedan.rows[0].n).toBeGreaterThan(0);
      // la historia del ticket no se cambia ni se borra desde la aplicación
      const priv = await admin.query(
        "SELECT has_table_privilege('app_operaciones', 'pumping.ticket_historial', 'UPDATE') AS u, has_table_privilege('app_operaciones', 'pumping.ticket_historial', 'DELETE') AS d",
      );
      expect(priv.rows[0]).toEqual({ u: false, d: false });
    } finally {
      await admin.query('DELETE FROM pumping.aceptacion_terminos WHERE ticket_id = $1', [t.id]);
    }
  });

  it('lectura del detalle: con `pumping.tickets.ver` (Mantenimiento) se abre el ticket, pero no se lista ni se opera', async () => {
    const t = await ticketEnTraslado();
    const soloVer = como('jefe_mantenimiento', CO1.id, CO1.nombre, [P.PUMPING_VER]);
    const d = (await http().get(`${base}/tickets/${t.id}`).set(soloVer).expect(200)).body as {
      id: string;
    };
    expect(d.id).toBe(t.id);
    await http().get(`${base}/tickets`).set(soloVer).expect(403);
    await http()
      .post(`${base}/tickets/${t.id}/avanzar`)
      .set(soloVer)
      .send({ hacia: 'x' })
      .expect(403);
  });

  it('mis-viajes (portal del Conductor): solo los tickets donde la cuenta está asignada como conductor u operador, con los datos mínimos y el supervisor; exige su propio permiso', async () => {
    const t = await ticketEnTraslado();
    const permiso = [P.PUMPING_CONTEXTO_CONDUCTOR];
    const lista = async (h: Record<string, string>) =>
      (await http().get(`${base}/tickets/mis-viajes`).set(h).expect(200)).body as {
        ticketId: string;
        ticketNumero: number;
        supervisor: { id: string; nombre: string } | null;
        paso: { codigo: string };
        tiposViaje: string[];
        unidades: { unidadId: string; placa: string }[];
        destino: { pozo: { id: string } | null };
        serviciosPrincipales: { codigo: string; nombre: string }[];
      }[];
    const delConductor = await lista(como('conductor', CO1.id, CO1.nombre, permiso));
    expect(delConductor.map((x) => x.ticketId)).toContain(t.id);
    const mios = await lista(como('operador', OP1.id, OP1.nombre, permiso));
    const v = mios.find((x) => x.ticketId === t.id)!;
    expect(v).toBeDefined();
    expect(v.supervisor).toEqual({ id: SUPERVISORA.id, nombre: SUPERVISORA.nombre });
    expect(Object.keys(v).sort()).toEqual(
      [
        'cliente',
        'destino',
        'paso',
        'pedidoCodigo',
        'serviciosPrincipales',
        'supervisor',
        'ticketId',
        'ticketNumero',
        'tiposViaje',
        'unidades',
      ].sort(),
    );
    // el conductor ve solo su unidad y el gerenciamiento de salida que le toca (el ticket está en Traslado de salida)
    expect(v.paso.codigo).toBe('traslado_salida');
    expect(v.tiposViaje).toEqual(['salida']);
    expect(v.unidades).toEqual([
      { unidadId: VEHICULO.unidadId, codigo: VEHICULO.unidadCodigo, placa: VEHICULO.placa },
    ]);
    const viajeConductor = (await lista(como('conductor', CO1.id, CO1.nombre, permiso))).find(
      (x) => x.ticketId === t.id,
    )!;
    expect(viajeConductor.unidades).toEqual([
      { unidadId: VEHICULO.unidadId, codigo: VEHICULO.unidadCodigo, placa: VEHICULO.placa },
    ]);
    // otro operador (no asignado) no ve el ticket; el supervisor tampoco (no es operador del ticket)
    expect(
      (await lista(como('operador', uuidv7(), 'Otro', permiso))).map((x) => x.ticketId),
    ).not.toContain(t.id);
    expect(
      (await lista(como('supervisor', SUPERVISORA.id, SUPERVISORA.nombre, permiso))).map(
        (x) => x.ticketId,
      ),
    ).not.toContain(t.id);
    // sin el permiso propio no se entra, aunque pueda operar tickets
    await http().get(`${base}/tickets/mis-viajes`).set(op1()).expect(403);
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
    // 2 EPI + 2 términos y el PTW del primer día: la inspección, el reporte de unidad y el gerenciamiento de viaje son de cada jornada
    expect(falta).toHaveLength(2 * 2 + 1);
    expect(falta).toContain('PTW del primer día de operación abierto');
    expect(falta).toContain(`Entrega de EPI despachada (${OP1.nombre})`);
    expect(falta.some((f) => /inspecci|Reporte de unidad|viaje/i.test(f))).toBe(false);
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
    // QHSE usa la aceptación como la declaración del trabajador en su entrega de EPI: se le avisa una sola vez (la repetida no avisa de nuevo)
    const avisos = await admin.query(
      "SELECT datos FROM msg_operaciones.outbox WHERE tipo = 'operaciones.pumping.terminos_aceptados' AND datos->'data'->>'ticketId' = $1",
      [t.id],
    );
    expect(avisos.rows).toHaveLength(1);
    expect(avisos.rows[0].datos.data).toMatchObject({
      ticketId: t.id,
      usuarioId: OP1.id,
      versionCodigo: 'PUMP-TyC-v1',
    });
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
    await http().patch(url).set(op1()).send({ toolboxTalkRealizado: true }).expect(409);
    // la ejecución llega con sus pasos propios (aún sin construir): aquí se lleva el ticket a ese paso
    await admin.query(
      "UPDATE pumping.ticket SET paso_codigo = 'ejecucion_operativa' WHERE id = $1",
      [t.id],
    );
    const inicial = (await http().get(url).set(op1()).expect(200)).body;
    expect(inicial.completo).toBe(false);
    expect(inicial.loto).toHaveLength(4);
    expect(inicial.limites.map((l: { gas: string }) => l.gas)).toEqual(['h2s', 'lel', 'o2', 'co']);

    await http()
      .patch(url)
      .set(op1())
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
        .set(op1())
        .send({ nuevaLectura: { gas: 'h2s', lectura: 15 } })
        .expect(200)
    ).body;
    expect(insegura.lecturas.at(-1)).toMatchObject({
      gas: 'h2s',
      lectura: 15,
      seguro: false,
      medidoPor: OP1.nombre,
    });
    for (const l of [
      { gas: 'h2s', lectura: 3 },
      { gas: 'lel', lectura: 0 },
      { gas: 'o2', lectura: 19.5 },
      { gas: 'co', lectura: 24.9 },
    ]) {
      await http().patch(url).set(op1()).send({ nuevaLectura: l }).expect(200);
    }
    const sinLoto = (await http().get(url).set(op1()).expect(200)).body;
    expect(sinLoto.completo).toBe(false);
    expect(sinLoto.lecturas.filter((l: { gas: string }) => l.gas === 'o2')[0].seguro).toBe(true); // 19.5 es el mínimo, inclusive
    for (const l of sinLoto.loto)
      await http().patch(`${url}/loto/${l.itemId}`).set(op1()).expect(200);
    const completo = (await http().get(url).set(op1()).expect(200)).body;
    expect(completo).toMatchObject({ completo: true, confirmadoPor: expect.any(String) });
    expect(completo.lotoNotificadoClienteAt).not.toBeNull();
    // desmarcar un ítem lo deja incompleto
    await http().patch(`${url}/loto/${completo.loto[0].itemId}`).set(op1()).expect(200);
    expect((await http().get(url).set(op1()).expect(200)).body).toMatchObject({
      completo: false,
      confirmadoPor: null,
    });
    // validaciones
    await http()
      .patch(url)
      .set(op1())
      .send({ nuevaLectura: { gas: 'xx', lectura: 1 } })
      .expect(400);
    await http()
      .patch(url)
      .set(op1())
      .send({ nuevaLectura: { gas: 'co', lectura: -1 } })
      .expect(400);
    await http().patch(url).set(operador()).send({ toolboxTalkRealizado: false }).expect(403); // no es del equipo
    // el Supervisor del ticket tampoco lo llena: el checklist es del Operador
    await http().patch(url).set(supervisora()).send({ toolboxTalkRealizado: false }).expect(403);
  });

  it('requisitos de otros módulos: los cumple solo el evento de su dueño (idempotente); el puente manual ya no existe', async () => {
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
    // eventos de Flota: lo que hace por unidad y día queda guardado (aunque el ticket aún no tenga jornadas) y lo toma cada jornada
    const DIA = '2026-11-05';
    const hechos = async () =>
      (
        await admin.query(
          'SELECT tipo, unidad_id, fecha::text AS fecha, vigente FROM pumping.ticket_hecho_traslado WHERE ticket_id = $1 ORDER BY tipo, unidad_id',
          [t.id],
        )
      ).rows;
    const realizada = externo(
      'flota.inspeccion_vehiculo.realizada',
      { ticketId: t.id, unidadId: VEHICULO.unidadId, diaServicio: DIA },
      'flota',
    );
    await externos.consumir(realizada);
    await externos.consumir(realizada); // el mismo evento: lo ignora el inbox
    expect(await hechos()).toEqual([
      { tipo: 'inspeccion_realizada', unidad_id: VEHICULO.unidadId, fecha: DIA, vigente: true },
    ]);
    // sin el día del servicio no hay jornada a la que pertenezca: se ignora
    await externos.consumir(
      externo(
        'flota.inspeccion_vehiculo.realizada',
        { ticketId: t.id, unidadId: VEHICULO_2.unidadId },
        'flota',
      ),
    );
    expect(await hechos()).toHaveLength(1);
    // al quedar realizada la inspección se avisa al Supervisor asignado (una sola vez, aunque el evento se repita)
    const avisos = await admin.query(
      "SELECT datos->'data' AS d FROM msg_operaciones.outbox WHERE tipo = 'operaciones.pumping.inspeccion_realizada' AND datos->'data'->>'ticketId' = $1",
      [t.id],
    );
    expect(avisos.rows).toHaveLength(1);
    expect(avisos.rows[0].d).toMatchObject({ unidad: VEHICULO.placa, cliente: CLIENTE.nombre });
    expect(avisos.rows[0].d.asignados).toEqual([
      { usuarioId: SUPERVISORA.id, rolCodigo: 'supervisor' },
    ]);
    // gerenciamiento de viaje (lo aprueba su dueño): uno de salida y otro de retorno por unidad y por día
    const viaje = (hecho: string, tipo: string, unidadId = VEHICULO.unidadId) =>
      externo(hecho, { ticketId: t.id, tipo, unidadId, diaServicio: DIA }, 'flota');
    await externos.consumir(viaje('flota.gerenciamiento_viaje.aprobado', 'salida'));
    await externos.consumir(viaje('flota.gerenciamiento_viaje.aprobado', 'otro')); // tipo desconocido: se ignora
    expect((await hechos()).map((h) => [h.tipo, h.vigente])).toEqual([
      ['inspeccion_realizada', true],
      ['gerenciamiento_salida', true],
    ]);
    // el de la otra unidad es suyo: no cumple el de esta
    await externos.consumir(
      viaje('flota.gerenciamiento_viaje.aprobado', 'retorno', VEHICULO_2.unidadId),
    );
    expect(
      (await hechos()).filter((h) => h.tipo === 'gerenciamiento_retorno').map((h) => h.unidad_id),
    ).toEqual([VEHICULO_2.unidadId]);
    // un rechazo retira lo aprobado
    await externos.consumir(viaje('flota.gerenciamiento_viaje.rechazado', 'salida'));
    expect((await hechos()).find((h) => h.tipo === 'gerenciamiento_salida')?.vigente).toBe(false);
    // un evento sin ticket o de un tipo desconocido no rompe nada
    await externos.consumir(externo('qhse.epi.despachada', { usuarioId: OP1.id }));
    await externos.consumir(externo('qhse.otra_cosa', { ticketId: t.id }));

    // el puente manual se retiró (27/10/2026): ni la ruta existe ni la base admite ese origen
    const epiOp2 = req.find((x) => x.codigo === 'epi_despachado' && x.para === OP2.nombre)!;
    await http()
      .post(`${base}/requisitos/${epiOp2.id}/cumplir-manual`)
      .set(jefe())
      .send({ motivo: 'QHSE aún no está en el portal nuevo' })
      .expect(404);
    await expect(
      admin.query(
        "UPDATE pumping.ticket_requisito SET origen = 'manual_temporal', motivo = 'x', cumplido_por = $2, cumplido_at = now(), estado = 'cumplido' WHERE id = $1",
        [epiOp2.id, JEFE],
      ),
    ).rejects.toThrow(/ticket_requisito_sin_manual_check/);
  });

  it('D9: QHSE valida el texto de los términos o publica una versión nueva; la anterior queda como constancia y solo QHSE puede', async () => {
    const urlV = `${base}/terminos/versiones`;
    // el operador no administra los términos
    await http().get(urlV).set(op1()).expect(403);
    await http().post(`${urlV}/PUMP-TyC-v1/validar`).set(op1()).expect(403);
    const vigenteAntes = (await http().get(`${base}/terminos/vigente`).set(op1()).expect(200)).body;
    const lista = (await http().get(urlV).set(qhse()).expect(200)).body;
    const v1 = lista.find((v: { codigo: string }) => v.codigo === vigenteAntes.codigo);
    expect(v1).toMatchObject({ vigente: true });
    if (!v1.validada) {
      expect(vigenteAntes.validada).toBe(false); // borrador hasta que QHSE lo valide
      await http().post(`${urlV}/${v1.codigo}/validar`).set(qhse()).expect(201);
      await http().post(`${urlV}/${v1.codigo}/validar`).set(qhse()).expect(409);
      expect(
        (await http().get(`${base}/terminos/vigente`).set(op1()).expect(200)).body.validada,
      ).toBe(true);
    }
    await http().post(urlV).set(qhse()).send({ titulo: 'x', texto: 'corto' }).expect(400);
    const texto =
      'Texto de prueba de la versión nueva de los términos y condiciones de uso de equipos. '.repeat(
        2,
      );
    const nueva = (
      await http().post(urlV).set(qhse()).send({ titulo: 'Términos de prueba', texto }).expect(201)
    ).body;
    const n = nueva.find((v: { vigente: boolean }) => v.vigente);
    expect(n).toMatchObject({ validada: true, titulo: 'Términos de prueba' });
    expect(n.textoHash).toBe(hashTexto(texto.trim()));
    expect(n.codigo).not.toBe(v1.codigo);
    // la anterior deja de ser la vigente pero se conserva
    expect(nueva.find((v: { codigo: string }) => v.codigo === v1.codigo)).toMatchObject({
      vigente: false,
    });
    // deja la versión original como vigente para no alterar las demás pruebas
    await admin.query('DELETE FROM pumping.terminos_version WHERE codigo = $1', [n.codigo]);
    await admin.query('UPDATE pumping.terminos_version SET vigente = true WHERE codigo = $1', [
      v1.codigo,
    ]);
    if (!v1.validada) {
      await admin.query(
        'UPDATE pumping.terminos_version SET validado_at = NULL, validado_por = NULL WHERE codigo = $1',
        [v1.codigo],
      );
    }
  });

  it('SWA y PTW de QHSE bloquean la salida del traslado: una SWA activa la frena hasta que no quede ninguna, y el PTW del primer día debe existir', async () => {
    const t = await ticketEnTraslado();
    const salida = () =>
      http().post(`${t.url}/avanzar`).set(op1()).send({ hacia: 'revision_reportes_salida' });
    // solo los de QHSE que bloquean la salida del traslado (los de pasos posteriores siguen pendientes)
    const faltan = async () =>
      (await requisitosDe(t.id))
        .filter(
          (x) =>
            x.estado === 'pendiente' &&
            ['swa_sin_activar', 'ptw_primer_dia_abierto'].includes(x.codigo),
        )
        .map((x) => x.codigo);
    await cumplirTodoMenosReporte(t.id);
    // con todo cumplido (y sin SWA) el traslado puede salir: se prueba el bloqueo antes de avanzar
    // SWA activada: reabre el requisito y el paso no avanza
    await externos.consumir(
      externo('qhse.swa.activado', {
        ticketId: t.id,
        swaId: uuidv7(),
        swaActivasEnTicket: 1,
        sinSwaActivas: false,
      }),
    );
    expect(await faltan()).toEqual(['swa_sin_activar']);
    const r = await salida().expect(409);
    expect(r.body.code).toBe('REQUISITOS_PENDIENTES');
    expect(String(r.body.detail)).toContain('Sin Stop Work Authority activa');
    // cerrar una SWA cuando quedan otras activas NO lo libera; al cerrar la última, sí (y el aviso repetido no cambia nada)
    await externos.consumir(
      externo('qhse.swa.cerrado', {
        ticketId: t.id,
        swaId: uuidv7(),
        swaActivasEnTicket: 1,
        sinSwaActivas: false,
      }),
    );
    expect(await faltan()).toEqual(['swa_sin_activar']);
    const ultima = externo('qhse.swa.cerrado', {
      ticketId: t.id,
      swaId: uuidv7(),
      swaActivasEnTicket: 0,
      sinSwaActivas: true,
    });
    await externos.consumir(ultima);
    await externos.consumir(ultima);
    expect(await faltan()).toEqual([]);
    // un PTW anulado vuelve a exigirse; un PTW de otro día (no el primero) no cuenta
    await externos.consumir(
      externo('qhse.ptw.anulado', {
        ticketId: t.id,
        ...(await diaInicio(t.id)),
        motivo: 'cambió el plan',
      }),
    );
    expect(await faltan()).toEqual(['ptw_primer_dia_abierto']);
    // si QHSE lo reintegra, el requisito se cumple otra vez; si lo vuelve a anular, vuelve a exigirse
    await externos.consumir(
      externo('qhse.ptw.reintegrado', {
        ticketId: t.id,
        ...(await diaInicio(t.id)),
        fase: 'gabinete',
      }),
    );
    expect(await faltan()).toEqual([]);
    await externos.consumir(
      externo('qhse.ptw.anulado', {
        ticketId: t.id,
        ...(await diaInicio(t.id)),
        motivo: 'otra vez',
      }),
    );
    expect(await faltan()).toEqual(['ptw_primer_dia_abierto']);
    await externos.consumir(
      externo('qhse.ptw.abierto', { ticketId: t.id, diaOperacion: '2030-01-01' }),
    );
    if ((await diaInicio(t.id)).diaOperacion)
      expect(await faltan()).toEqual(['ptw_primer_dia_abierto']);
    await externos.consumir(
      externo('qhse.ptw.cerrado', { ticketId: t.id, ...(await diaInicio(t.id)) }),
    );
    expect(await faltan()).toEqual([]);
    // una SWA sin servicio no afecta a ningún ticket
    await externos.consumir(externo('qhse.swa.activado', { ticketId: null, swaId: uuidv7() }));
    expect(await faltan()).toEqual([]);
    await salida().expect(201);
  });

  it('los avisos de SWA y PTW que llegan antes de que la asignación genere los requisitos no se pierden', async () => {
    const t = await ticketEnTraslado();
    await admin.query(
      "DELETE FROM pumping.ticket_requisito WHERE ticket_id = $1 AND requisito_codigo IN ('swa_sin_activar', 'ptw_primer_dia_abierto')",
      [t.id],
    );
    await externos.consumir(externo('qhse.swa.activado', { ticketId: t.id, swaId: uuidv7() }));
    await externos.consumir(
      externo('qhse.ptw.abierto', { ticketId: t.id, ...(await diaInicio(t.id)) }),
    );
    const req = await requisitosDe(t.id);
    expect(req.find((x) => x.codigo === 'swa_sin_activar')).toMatchObject({ estado: 'pendiente' });
    expect(req.find((x) => x.codigo === 'ptw_primer_dia_abierto')).toMatchObject({
      estado: 'cumplido',
      origen: 'evento',
    });
    expect(req.filter((x) => x.codigo === 'swa_sin_activar')).toHaveLength(1);
  });

  it('el reporte de unidad de salida lo firma el operador de cada unidad, solo con los demás requisitos del traslado cumplidos; el ticket sale del traslado sin depender de él (lo exige cada jornada) y se avisa al supervisor', async () => {
    const t = await ticketEnTraslado();
    const reporteUrl = (v: string) => `${t.url}/reportes-unidad/${v}/salida`;
    // el listado de unidades con su operador
    const lista = (await http().get(`${t.url}/reportes-unidad`).set(op1()).expect(200)).body;
    expect(lista).toEqual(
      [
        {
          unidadId: VEHICULO.unidadId,
          codigo: VEHICULO.unidadCodigo,
          nombre: `Unidad de prueba ${VEHICULO.placa}`,
          placa: VEHICULO.placa,
          operador: { usuarioId: OP1.id, nombre: OP1.nombre },
          fecha: null,
          salidaFirmada: false,
          llegadaFirmada: false,
          salidaFirmadaAt: null,
        },
        {
          unidadId: VEHICULO_2.unidadId,
          codigo: VEHICULO_2.unidadCodigo,
          nombre: `Unidad de prueba ${VEHICULO_2.placa}`,
          placa: VEHICULO_2.placa,
          operador: { usuarioId: OP2.id, nombre: OP2.nombre },
          fecha: null,
          salidaFirmada: false,
          llegadaFirmada: false,
          salidaFirmadaAt: null,
        },
      ].sort((a, b) => a.placa.localeCompare(b.placa)),
    );

    // sin los demás requisitos no se puede firmar
    const cuerpo1 = await salidaValida(t.id, VEHICULO.unidadId);
    const bloqueado = await http()
      .put(reporteUrl(VEHICULO.unidadId))
      .set(op1())
      .send(cuerpo1)
      .expect(409);
    expect(bloqueado.body.code).toBe('REQUISITOS_PENDIENTES');
    await cumplirTodoMenosReporte(t.id);

    // validaciones del cuerpo y de quién firma
    await http()
      .put(reporteUrl(VEHICULO.unidadId))
      .set(op1())
      .send({ ...cuerpo1, fecha: '05/11/2026' })
      .expect(400);
    await http()
      .put(reporteUrl(VEHICULO.unidadId))
      .set(op1())
      .send({ ...cuerpo1, origen: '' })
      .expect(400);
    // punto 8: el origen y el destino son texto libre, obligatorio y de hasta 200 caracteres
    await http()
      .put(reporteUrl(VEHICULO.unidadId))
      .set(op1())
      .send({ ...cuerpo1, origen: '   ' })
      .expect(400);
    await http()
      .put(reporteUrl(VEHICULO.unidadId))
      .set(op1())
      .send({ ...cuerpo1, destino: 'x'.repeat(201) })
      .expect(400);
    await http()
      .put(reporteUrl(VEHICULO.unidadId))
      .set(op1())
      .send({ ...cuerpo1, destino: { pozoId: POZO.id } })
      .expect(400);
    await http()
      .put(reporteUrl(VEHICULO.unidadId))
      .set(op1())
      .send({ ...cuerpo1, combustible: -1 })
      .expect(400);
    await http()
      .put(reporteUrl(VEHICULO.unidadId))
      .set(op1())
      .send({ ...cuerpo1, hubodometros: [...cuerpo1.hubodometros, cuerpo1.hubodometros[0]] })
      .expect(400);
    await http()
      .put(reporteUrl(VEHICULO.unidadId))
      .set(op1())
      .send({ ...cuerpo1, inspecciones: [{ itemId: uuidv7(), resultado: 'conforme' }] })
      .expect(400);
    await http().put(reporteUrl(VEHICULO_2.unidadId)).set(op1()).send(cuerpo1).expect(403); // la unidad del otro operador
    await http().put(reporteUrl(VEHICULO.unidadId)).set(operador()).send(cuerpo1).expect(403); // un operador que no es del ticket
    await http().put(reporteUrl(uuidv7())).set(op1()).send(cuerpo1).expect(404);
    const firmado = (
      await http().put(reporteUrl(VEHICULO.unidadId)).set(op1()).send(cuerpo1).expect(200)
    ).body;
    expect(firmado).toMatchObject({
      placa: VEHICULO.placa,
      origen: 'Base Coco',
      destino: 'Pozo Beta-9',
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
      .put(reporteUrl(VEHICULO.unidadId))
      .set(op1())
      .send({ ...cuerpo1, combustible: 70 })
      .expect(200);
    expect(
      (await http().get(`${t.url}/reportes-unidad/${VEHICULO.unidadId}`).set(op1()).expect(200))
        .body.salida.combustible,
    ).toBe(70);

    const cuerpo2 = await salidaValida(t.id, VEHICULO_2.unidadId);
    await http().put(reporteUrl(VEHICULO_2.unidadId)).set(op2()).send(cuerpo2).expect(200);

    // lo del traslado cumplido: sale hacia la revisión de reportes de salida
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
    await http().put(reporteUrl(VEHICULO.unidadId)).set(op1()).send(cuerpo1).expect(409);

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
    const inicio = (
      await admin.query(
        'SELECT fecha_inicio_servicio::text AS f FROM pumping.ticket WHERE id = $1',
        [t.id],
      )
    ).rows[0].f as string;
    await cumplirTodoMenosReporte(t.id);
    for (const [v, o] of [
      [VEHICULO, op1()],
      [VEHICULO_2, op2()],
    ] as const) {
      const cuerpoSalida = await salidaValida(t.id, v.unidadId);
      await http()
        .put(`${t.url}/reportes-unidad/${v.unidadId}/${inicio}/salida`)
        .set(o)
        .send(cuerpoSalida)
        .expect(200);
    }
    await http()
      .post(`${t.url}/avanzar`)
      .set(op1())
      .send({ hacia: 'revision_reportes_salida' })
      .expect(201);

    // revisión de salida: no se pasa a la ejecución sin la inspección de cada unidad aprobada (los reportes ya están firmados); el
    // gerenciamiento de viaje de salida no es del paso: lo exige cada jornada
    const sinInspeccion = await http()
      .post(`${t.url}/avanzar`)
      .set(supervisora())
      .send({ hacia: 'ejecucion_operativa' })
      .expect(409);
    expect(sinInspeccion.body.code).toBe('REQUISITOS_PENDIENTES');
    expect(sinInspeccion.body.detail).toContain('Inspección de vehículo aprobada');
    expect(sinInspeccion.body.detail).not.toContain('Reporte de unidad de salida firmado');
    for (const v of [VEHICULO, VEHICULO_2])
      await admin.query(
        "INSERT INTO pumping.ticket_hecho_traslado (id, ticket_id, unidad_id, fecha, tipo, vigente) VALUES (gen_random_uuid(), $1, $2, $3, 'inspeccion_aprobada', true)",
        [t.id, v.unidadId, inicio],
      );
    await http()
      .post(`${t.url}/avanzar`)
      .set(supervisora())
      .send({ hacia: 'ejecucion_operativa' })
      .expect(201);

    // ejecución: para salir hace falta el Reporte de Herramientas completo y todas las jornadas resueltas (el checklist de seguridad y la
    // aceptación del Company Man son requisitos de cada día: tienen su prueba propia)
    const faltaReporte = await http()
      .post(`${t.url}/avanzar`)
      .set(op1())
      .send({ hacia: 'control_retorno' })
      .expect(409);
    expect(faltaReporte.body.detail).toContain('Reporte de herramientas completado');
    await prisma.ticketRequisito.updateMany({
      where: { ticketId: t.id, requisitoCodigo: 'reporte_herramientas_completado' },
      data: { estado: 'cumplido', cumplidoAt: new Date(), origen: 'sistema' },
    });
    const faltanJornadas = await http()
      .post(`${t.url}/avanzar`)
      .set(op1())
      .send({ hacia: 'control_retorno' })
      .expect(409);
    expect(faltanJornadas.body.code).toBe('JORNADAS_PENDIENTES');
    // los días del servicio de esta prueba aún no llegan: no se exigen, pero hace falta al menos una jornada registrada
    expect(faltanJornadas.body.detail).toContain('Registre al menos la jornada de hoy');
    // la ruta anterior «formalizar» marca la aceptación del Company Man de hoy
    const formalizar = `${t.url}/ejecucion/formalizar`;
    await http().post(formalizar).set(op1()).expect(403); // sin el permiso
    await http()
      .post(formalizar)
      .set(como('supervisor', OP1.id, OP1.nombre, [P.PUMPING_EJECUCION_FORMALIZAR]))
      .expect(403); // con el permiso, pero no es el supervisor asignado
    await http()
      .post(formalizar)
      .set(como('supervisor', SUPERVISORA.id, SUPERVISORA.nombre, [P.PUMPING_EJECUCION_FORMALIZAR]))
      .expect(404); // hoy no es día de servicio de este ticket de prueba
    await http().get(`${t.url}/jornadas`).set(op1()).expect(200);
    await admin.query(
      "UPDATE pumping.ticket_jornada SET estado = 'cerrada', cerrada_at = now(), cerrada_por = $2 WHERE ticket_id = $1 AND estado IN ('pendiente', 'abierta')",
      [t.id, JEFE],
    );
    // esta prueba solo recorre el primer día hasta el final: los demás días no cuentan
    await admin.query(
      "UPDATE pumping.ticket_jornada SET estado = 'no_aplica' WHERE ticket_id = $1 AND fecha <> $2::date",
      [t.id, inicio],
    );
    await http().post(`${t.url}/avanzar`).set(op1()).send({ hacia: 'control_retorno' }).expect(201);

    // control de retorno: el gerenciamiento de viaje de retorno de cada unidad y día trabajado (lo aprueba Flota)
    const sinRetorno = await http()
      .post(`${t.url}/avanzar`)
      .set(supervisora())
      .send({ hacia: 'traslado_llegada' })
      .expect(409);
    expect(sinRetorno.body.code).toBe('REQUISITOS_PENDIENTES');
    expect(sinRetorno.body.detail).toContain('Gerenciamiento de viaje de retorno');
    for (const v of [VEHICULO, VEHICULO_2])
      await externos.consumir(
        externo(
          'flota.gerenciamiento_viaje.aprobado',
          { ticketId: t.id, unidadId: v.unidadId, diaServicio: inicio, tipo: 'retorno' },
          'flota',
        ),
      );
    await http()
      .post(`${t.url}/avanzar`)
      .set(supervisora())
      .send({ hacia: 'traslado_llegada' })
      .expect(201);

    // traslado de llegada: sin el reporte de llegada firmado de cada unidad no se pasa a la revisión
    const sinReporte = await http()
      .post(`${t.url}/avanzar`)
      .set(op1())
      .send({ hacia: 'revision_reportes_llegada' })
      .expect(409);
    expect(sinReporte.body.code).toBe('REQUISITOS_PENDIENTES');
    expect(sinReporte.body.detail).toContain('Firmar el reporte de unidad de llegada');
    // cada operador firma la llegada de su unidad (publica el evento para Mantenimiento)
    const llegada = async (unidadId: string, extra: object = {}) => {
      const r = (
        await http().get(`${t.url}/reportes-unidad/${unidadId}`).set(supervisora()).expect(200)
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
    const cuerpoLlegada2 = await llegada(VEHICULO_2.unidadId);
    await http().put(urlLlegada(VEHICULO_2.unidadId)).set(op1()).send(cuerpoLlegada2).expect(403);
    const interrumpida = await llegada(VEHICULO.unidadId, { operacionInterrumpida: true });
    const conNovedad = await llegada(VEHICULO.unidadId, {
      novedadesMecanica: 'Ruido en el eje trasero',
    });
    await http().put(urlLlegada(VEHICULO.unidadId)).set(op1()).send(interrumpida).expect(400);
    const l1 = (
      await http().put(urlLlegada(VEHICULO.unidadId)).set(op1()).send(conNovedad).expect(200)
    ).body;
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
    await http().put(urlLlegada(VEHICULO_2.unidadId)).set(op2()).send(cuerpoLlegada2).expect(200);
    const eventosLlegada = await admin.query(
      "SELECT datos->'data' AS d FROM msg_operaciones.outbox WHERE tipo = 'operaciones.pumping.reporte_unidad_llegada' AND datos->'data'->>'ticketId' = $1",
      [t.id],
    );
    expect(eventosLlegada.rows).toHaveLength(2);
    expect(eventosLlegada.rows.map((x) => x.d.hayNovedades).sort()).toEqual([false, true]);
    // D2: el evento lleva la unidad de Flota y, mientras algún consumidor lo lea, el vehículo del catálogo enlazado
    expect(
      eventosLlegada.rows
        .map((x) => [x.d.unidadId, x.d.vehiculoId])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ).toEqual(
      [
        [VEHICULO.unidadId, VEHICULO.id],
        [VEHICULO_2.unidadId, VEHICULO_2.id],
      ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    );
    await http()
      .post(`${t.url}/avanzar`)
      .set(op1())
      .send({ hacia: 'revision_reportes_llegada' })
      .expect(201);

    // revisión final: el cierre exige el Acta de Entrega de Locación; el rechazo vuelve con motivo
    // revisión de llegada: el Supervisor aprueba la inspección de llegada (Flota) y el reporte de llegada de cada unidad y día trabajado.
    const revisor = () =>
      como('supervisor', SUPERVISORA.id, SUPERVISORA.nombre, [P.PUMPING_REPORTE_LLEGADA_REVISAR]);
    const urlRevision = (v: string) => `${t.url}/reportes-unidad/${v}/${inicio}/llegada/revision`;
    const sinRevision = await http()
      .post(`${t.url}/avanzar`)
      .set(supervisora())
      .send({ hacia: 'revision_final' })
      .expect(409);
    expect(sinRevision.body.code).toBe('REQUISITOS_PENDIENTES');
    expect(sinRevision.body.detail).toContain('inspección de llegada');
    expect(sinRevision.body.detail).toContain('reporte de llegada');
    const filas = (await http().get(`${t.url}/revision-llegada`).set(supervisora()).expect(200))
      .body as Array<{ unidadId: string; inspeccion: string; reporte: string }>;
    expect(filas).toHaveLength(2);
    expect(filas.every((f) => f.inspeccion === 'pendiente' && f.reporte === 'por_revisar')).toBe(
      true,
    );
    // la inspección de llegada llega de Flota por evento y no toca la de salida
    for (const v of [VEHICULO, VEHICULO_2])
      await externos.consumir(
        externo(
          'flota.inspeccion_vehiculo.registrada',
          {
            ticketId: t.id,
            unidadId: v.unidadId,
            diaServicio: inicio,
            momento: 'llegada',
          },
          'flota',
        ),
      );
    expect(
      (await http().get(`${t.url}/revision-llegada`).set(supervisora()).expect(200)).body.map(
        (f: { inspeccion: string }) => f.inspeccion,
      ),
    ).toEqual(['por_aprobar', 'por_aprobar']);
    for (const v of [VEHICULO, VEHICULO_2])
      await externos.consumir(
        externo(
          'flota.inspeccion_vehiculo.aprobada',
          {
            ticketId: t.id,
            unidadId: v.unidadId,
            diaServicio: inicio,
            momento: 'llegada',
          },
          'flota',
        ),
      );
    expect(
      (await http().get(`${t.url}/revision-llegada`).set(supervisora()).expect(200)).body.map(
        (f: { inspeccion: string }) => f.inspeccion,
      ),
    ).toEqual(['aprobada', 'aprobada']);
    // el reporte: solo el Supervisor con el permiso; el rechazo exige motivo y deja al Operador volver a firmar; lo aprobado ya no se toca
    await http()
      .post(urlRevision(VEHICULO.unidadId))
      .set(supervisora())
      .send({ decision: 'aprobada' })
      .expect(403);
    await http()
      .post(urlRevision(VEHICULO.unidadId))
      .set(revisor())
      .send({ decision: 'rechazada' })
      .expect(400);
    await http()
      .post(urlRevision(VEHICULO.unidadId))
      .set(revisor())
      .send({ decision: 'rechazada', motivo: 'Falta el detalle del ruido' })
      .expect(201);
    const rechazada = (
      await http().get(`${t.url}/revision-llegada`).set(supervisora()).expect(200)
    ).body.find((f: { unidadId: string }) => f.unidadId === VEHICULO.unidadId);
    expect(rechazada).toMatchObject({ reporte: 'rechazado', motivo: 'Falta el detalle del ruido' });
    await http().put(urlLlegada(VEHICULO.unidadId)).set(op1()).send(conNovedad).expect(200);
    for (const v of [VEHICULO, VEHICULO_2])
      await http()
        .post(urlRevision(v.unidadId))
        .set(revisor())
        .send({ decision: 'aprobada' })
        .expect(201);
    await http().put(urlLlegada(VEHICULO.unidadId)).set(op1()).send(conNovedad).expect(409);
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
           VALUES ($1, $2, 'Articulo de prueba', $3, (SELECT id FROM catalogos.unidad_medida ORDER BY nombre LIMIT 1))`,
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
      // el consumo se anota en un día del servicio: el día de las pruebas es el único día de este ticket
      await admin.query(
        'UPDATE pumping.ticket SET fecha_inicio_servicio = $2, fecha_fin_servicio = $2 WHERE id = $1',
        [t.id, '2026-11-05'],
      );
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

    it('el consumo queda anotado por día del servicio: solo en una jornada activa que ya llegó, y el detalle lo muestra por día', async () => {
      await preparar();
      const t = await ticketEnAsignacion();
      await asignar(t, { quimicos: [linea(10)], documentoMezclaId: MEZCLA }).expect(201);
      await admin.query(
        'UPDATE pumping.ticket SET paso_codigo = $2, fecha_inicio_servicio = $3, fecha_fin_servicio = $4 WHERE id = $1',
        [t.id, 'ejecucion_operativa', '2026-11-05', '2026-11-07'],
      );
      const consumo = (cantidad: number, fecha?: string) =>
        http()
          .post(`${t.url}/quimicos/consumo`)
          .set(op1())
          .send({ articuloId: QUIMICO.id, cantidad, ...(fecha ? { fecha } : {}) });
      const reloj = jest.spyOn(app.get(JornadasService), 'hoy');
      try {
        expect((await consumo(2)).status).toBe(201); // hoy (el día 1) por omisión
        expect((await consumo(1, '2026-11-06')).status).toBe(409); // el día 2 todavía no llega
        expect((await consumo(1, '2026-11-09')).status).toBe(404); // fuera del servicio
        expect((await consumo(1, 'ayer')).status).toBe(400);

        reloj.mockReturnValue('2026-11-06');
        expect((await consumo(3)).status).toBe(201); // hoy (el día 2)
        const d = await consumo(1, '2026-11-05'); // se anota con retraso lo que se usó el día 1
        expect(d.status).toBe(201);
        expect(d.body.quimicos[0]).toMatchObject({ asignada: 10, usada: 6, pendiente: 4 });
        expect(d.body.quimicos[0].usadaPorDia).toEqual([
          { fecha: '2026-11-05', cantidad: 3 },
          { fecha: '2026-11-06', cantidad: 3 },
        ]);
        // un día sin operación ya no admite consumo
        await admin.query(
          "UPDATE pumping.ticket_jornada SET estado = 'cerrada', cerrada_at = now(), cerrada_por = $2 WHERE ticket_id = $1 AND fecha = '2026-11-05'",
          [t.id, JEFE],
        );
        expect((await consumo(1, '2026-11-05')).status).toBe(409);
      } finally {
        reloj.mockReturnValue('2026-11-05');
      }
      // el aviso de cada consumo lleva el día en que se usó
      const dias = (
        await admin.query(
          "SELECT datos->'data'->>'diaServicio' AS dia FROM msg_operaciones.outbox WHERE tipo = 'operaciones.inventario.consumo_registrado' AND datos->'data'->>'ticketId' = $1 ORDER BY id",
          [t.id],
        )
      ).rows.map((x) => x.dia);
      expect(dias).toEqual(['2026-11-05', '2026-11-06', '2026-11-05']);
    });
  });

  describe('inspección de vehículo aprobada: la aprueba Flota y llega por evento (ya no hay aprobación en Pumping)', () => {
    const DIA = '2026-11-05';
    const aprobada = async (id: string, unidadId: string) =>
      (
        await admin.query(
          "SELECT vigente FROM pumping.ticket_hecho_traslado WHERE ticket_id = $1 AND tipo = 'inspeccion_aprobada' AND unidad_id = $2 AND fecha = $3",
          [id, unidadId, DIA],
        )
      ).rows[0]?.vigente;

    it('el evento de Flota deja aprobada la inspección de esa unidad ese día (y la otra no); un rechazo la retira; la ruta vieja ya no existe', async () => {
      const t = await ticketEnTraslado();
      expect(await aprobada(t.id, VEHICULO.unidadId)).toBeUndefined();
      await externos.consumir(
        externo(
          'flota.inspeccion_vehiculo.aprobada',
          { ticketId: t.id, unidadId: VEHICULO.unidadId, diaServicio: DIA },
          'flota',
        ),
      );
      expect(await aprobada(t.id, VEHICULO.unidadId)).toBe(true);
      expect(await aprobada(t.id, VEHICULO_2.unidadId)).toBeUndefined();
      await externos.consumir(
        externo(
          'flota.inspeccion_vehiculo.rechazada',
          { ticketId: t.id, unidadId: VEHICULO.unidadId, diaServicio: DIA },
          'flota',
        ),
      );
      expect(await aprobada(t.id, VEHICULO.unidadId)).toBe(false);
      await http()
        .post(`${t.url}/revision-salida/inspecciones/${VEHICULO.unidadId}/aprobar`)
        .set(supervisora())
        .expect(404);
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

    it('el representante del día debe ser un representante de campo; la base también lo exige (OP-3)', async () => {
      const t = await enEjecucion();
      const otro = { id: uuidv7(), nombre: `Analista ${n}` };
      await admin.query(
        "INSERT INTO catalogos.persona_contacto (id, tipo, nombre) VALUES ($1, 'analista_facturacion', $2)",
        [otro.id, otro.nombre],
      );
      try {
        const cuerpo = { actividades: [actividad({})] };
        expect((await guardar(t, { ...cuerpo, representanteId: otro.id })).status).toBe(400);
        expect((await guardar(t, { ...cuerpo, representanteId: uuidv7() })).status).toBe(400);
        // sin indicarlo se conserva el del día; con null se deja vacío
        const r = await guardar(t, cuerpo);
        expect(r.body.representante).toMatchObject({ id: COMPANY_MAN.id });
        expect(
          (await guardar(t, { ...cuerpo, representanteId: null })).body.representante,
        ).toBeNull();
        expect((await guardar(t, cuerpo)).body.representante).toBeNull();
        await expect(
          admin.query(
            'UPDATE pumping.reporte_diario SET representante_id = $2 WHERE ticket_id = $1',
            [t.id, otro.id],
          ),
        ).rejects.toThrow(/representante de campo/);
      } finally {
        await admin.query('DELETE FROM pumping.reporte_diario WHERE ticket_id = $1', [t.id]);
        await admin.query('DELETE FROM catalogos.persona_contacto WHERE id = $1', [otro.id]);
      }
    });

    it('el adjunto del día es un archivo de la plataforma: una sola vez por reporte, y es historia (D-PD)', async () => {
      const t = await enEjecucion();
      const archivo = uuidv7();
      await admin.query(
        `INSERT INTO archivos.archivo (id, modulo_id, nombre_original, mime_type, tamano_bytes, sha256, blob_key, escaneo, subido_por)
         SELECT $1::uuid, mo.id, 'mezcla.pdf', 'application/pdf', 10, repeat('c', 64), 'prueba/' || $1::text, 'omitido', $2::uuid
           FROM archivos.modulo_archivo mo WHERE mo.codigo = 'pedido_documento'`,
        [archivo, JEFE],
      );
      try {
        const r = await guardar(t, { actividades: [actividad({})] });
        expect(r.status).toBe(200);
        const reporte = (
          await admin.query('SELECT id FROM pumping.reporte_diario WHERE ticket_id = $1', [t.id])
        ).rows[0].id;
        const insertar = (archivoId: string) =>
          admin.query(
            'INSERT INTO pumping.reporte_diario_adjunto (id, reporte_id, archivo_id, created_by) VALUES ($1, $2, $3, $4)',
            [uuidv7(), reporte, archivoId, JEFE],
          );
        await insertar(archivo);
        await expect(insertar(archivo)).rejects.toThrow(/reporte_diario_adjunto_key/); // una sola vez
        await expect(insertar(uuidv7())).rejects.toThrow(/reporte_diario_adjunto_archivo_fkey/); // el archivo existe
        // la aplicación no cambia ni borra un adjunto
        const privilegios = await admin.query(
          "SELECT has_table_privilege('app_operaciones', 'pumping.reporte_diario_adjunto', 'UPDATE') AS u, has_table_privilege('app_operaciones', 'pumping.reporte_diario_adjunto', 'DELETE') AS d",
        );
        expect(privilegios.rows[0]).toEqual({ u: false, d: false });
      } finally {
        await admin.query('DELETE FROM pumping.reporte_diario WHERE ticket_id = $1', [t.id]);
        await admin.query('DELETE FROM archivos.archivo WHERE id = $1', [archivo]);
      }
    });

    it('guarda el día como borrador, con la duración y las tablas de cada actividad calculadas y leídas del servidor', async () => {
      const t = await enEjecucion();
      const r = await guardar(t, {
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
        // OP-3: sin indicarlo, el día nace con el Company Man del ticket (que viene del pedido)
        representante: { id: COMPANY_MAN.id, nombre: COMPANY_MAN.nombre },
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

    describe('adjunto y firmas del día (D-PD)', () => {
      const archivos: string[] = [];
      const nuevoArchivo = async () => {
        const id = uuidv7();
        archivos.push(id);
        await admin.query(
          `INSERT INTO archivos.archivo (id, modulo_id, nombre_original, mime_type, tamano_bytes, sha256, blob_key, escaneo, subido_por)
           SELECT $1::uuid, mo.id, 'firmado.pdf', 'application/pdf', 10, encode(sha256($1::text::bytea), 'hex'), 'prueba/' || $1::text, 'omitido', $2::uuid
             FROM archivos.modulo_archivo mo WHERE mo.codigo = 'pedido_documento'`,
          [id, JEFE],
        );
        return id;
      };
      afterAll(async () => {
        await admin.query(
          'DELETE FROM pumping.reporte_diario_adjunto WHERE archivo_id = ANY($1::uuid[])',
          [archivos],
        );
        await admin.query(
          'DELETE FROM pumping.reporte_diario WHERE ticket_id IN (SELECT id FROM pumping.ticket WHERE pedido_id = ANY($1::uuid[]))',
          [pedidos],
        );
        await admin.query('DELETE FROM archivos.archivo WHERE id = ANY($1::uuid[])', [archivos]);
      });
      const firmas = async (documentoId: string) =>
        (
          await admin.query(
            "SELECT tipo, datos FROM msg_operaciones.outbox WHERE tipo = 'operaciones.pumping.reporte_diario.firmado' AND datos->'data'->>'documentoId' = $1 ORDER BY id",
            [documentoId],
          )
        ).rows.map((r) => r.datos);
      const firmar = (t: { url: string }, cuerpo: object, h = op1()) =>
        http()
          .post(`${url(t)}/firmas`)
          .set(h)
          .send(cuerpo);
      const adjuntar = (t: { url: string }, archivoId: string, h = op1()) =>
        http()
          .post(`${url(t)}/adjuntos`)
          .set(h)
          .send({ archivoId });

      it('adjunta archivos al día (uno solo una vez, que exista) y los devuelve con el reporte', async () => {
        const t = await enEjecucion();
        const a = await nuevoArchivo();
        expect((await adjuntar(t, a)).status).toBe(404); // el día aún no existe
        await guardar(t, { actividades: [actividad()] });
        const ok = await adjuntar(t, a);
        expect(ok.status).toBe(201);
        expect(ok.body.adjuntos).toEqual([
          { archivoId: a, at: expect.any(String), por: { id: OP1.id, nombre: OP1.nombre } },
        ]);
        expect((await adjuntar(t, a)).status).toBe(409);
        expect((await adjuntar(t, uuidv7())).status).toBe(400);
        expect(
          (await adjuntar(t, await nuevoArchivo(), como('operador', uuidv7(), 'Ajeno'))).status,
        ).toBe(403);
      });

      it('el Supervisor firma el día completado «de una línea» y el representante del cliente con su documento firmado; ambos llegan a Firmas', async () => {
        const t = await enEjecucion();
        await guardar(t, { actividades: [actividad()] });
        const reporte = (await http().get(url(t)).set(op1())).body.id as string;
        expect((await firmar(t, { rol: 'supervisor' }, supervisora())).body.code).toBe(
          'DIA_SIN_COMPLETAR',
        );
        await completar(t).expect(201);

        // solo el Supervisor del ticket firma como Supervisor, y sin archivo
        expect((await firmar(t, { rol: 'supervisor' })).status).toBe(403);
        expect(
          (await firmar(t, { rol: 'supervisor', archivoId: uuidv7() }, supervisora())).status,
        ).toBe(400);
        const ok = await firmar(t, { rol: 'supervisor' }, supervisora());
        expect(ok.status).toBe(201);
        const [f1] = await firmas(reporte);
        expect(f1.data).toMatchObject({
          documentoTipo: 'pumping_reporte_diario',
          documentoId: reporte,
          rolFirmante: 'supervisor',
          metodo: 'linea',
          ticketId: t.id,
          fecha: FECHA,
        });
        expect(f1.data.hashDocumento).toMatch(/^[0-9a-f]{64}$/);
        expect(f1.actor.userId).toBe(SUPERVISORA.id);

        // el representante del cliente firma en papel: el equipo sube el documento firmado
        expect((await firmar(t, { rol: 'representante_cliente' })).status).toBe(400); // falta el archivo
        expect(
          (await firmar(t, { rol: 'representante_cliente', archivoId: uuidv7() })).status,
        ).toBe(400);
        expect((await firmar(t, { rol: 'otro' })).status).toBe(400);
        const firmado = await nuevoArchivo();
        await firmar(t, { rol: 'representante_cliente', archivoId: firmado }).expect(201);
        const todas = await firmas(reporte);
        expect(todas).toHaveLength(2);
        expect(todas[1].data).toMatchObject({
          rolFirmante: 'representante_cliente',
          metodo: 'manuscrita',
          archivoId: firmado,
        });
        expect(todas[1].data.hashDocumento).toBeUndefined();

        // editar el día lo reabre: hay que completarlo antes de volver a firmar
        await guardar(t, { actividades: [actividad({ detalle: 'Otro trabajo' })] });
        expect((await firmar(t, { rol: 'supervisor' }, supervisora())).body.code).toBe(
          'DIA_SIN_COMPLETAR',
        );
      });
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

  describe('Reporte de Herramientas de Pumping (OP-1): líneas cotizadas repartidas por día', () => {
    const DIAS = ['2026-11-05', '2026-11-06', '2026-11-07'];
    let porDia = '';
    let porCantidad = '';
    beforeAll(async () => {
      const dia = await admin.query(
        "SELECT id FROM catalogos.unidad_medida WHERE periodo = 'dia' ORDER BY nombre LIMIT 1",
      );
      const otra = await admin.query(
        'SELECT id FROM catalogos.unidad_medida WHERE periodo IS NULL ORDER BY nombre LIMIT 1',
      );
      porDia = dia.rows[0].id;
      porCantidad = otra.rows[0].id;
    });
    const lineas = (extra: object[] = []) => [
      {
        codigo: `HT-DIA-${n}`,
        descripcion: 'Herramienta por día',
        unidadMedidaId: porDia,
        cantidad: 3,
        tipoLinea: 'herramienta',
      },
      {
        codigo: `HT-CANT-${n}`,
        descripcion: 'Material por cantidad',
        unidadMedidaId: porCantidad,
        cantidad: 10,
        tipoLinea: 'material',
      },
      {
        codigo: `MOV-${n}`,
        descripcion: 'Movilización',
        unidadMedidaId: porCantidad,
        cantidad: 1,
        tipoLinea: 'movilizacion',
      },
      ...extra,
    ];
    const actualizado = (pedidoId: string, data: Record<string, unknown>): EventEnvelope => {
      const id = uuidv7();
      eventos.push(id);
      return {
        id,
        type: 'comercial.pedido.actualizado',
        version: 1,
        occurredAt: new Date().toISOString(),
        source: 'comercial',
        subject: { type: 'pedido', id: pedidoId },
        data,
      } as EventEnvelope;
    };
    const ticket = async (extra: object[] = []) => {
      const t = await ticketEnTraslado();
      await admin.query(
        'UPDATE pumping.ticket SET paso_codigo = $2, fecha_inicio_servicio = $3, fecha_fin_servicio = $4 WHERE id = $1',
        [t.id, 'ejecucion_operativa', DIAS[0], DIAS[2]],
      );
      await consumer.consumir(actualizado(t.pedidoId, { lineas: lineas(extra) }));
      return t;
    };
    const url = (t: { url: string }) => `${t.url}/reporte-herramientas`;
    const ver = (t: { url: string }, h = op1()) => http().get(url(t)).set(h);
    const marcar = (
      t: { url: string },
      lineaId: string,
      fecha: string,
      cuerpo: object,
      h = op1(),
    ) =>
      http()
        .put(`${url(t)}/lineas/${lineaId}/dias/${fecha}`)
        .set(h)
        .send(cuerpo);
    const completar = (t: { url: string }, h = op1()) =>
      http()
        .post(`${url(t)}/completar`)
        .set(h);
    const eventosDe = async (ticketId: string) =>
      (
        await admin.query(
          "SELECT datos FROM msg_operaciones.outbox WHERE tipo = 'operaciones.pumping.reporte_herramientas_completado' AND datos->'data'->>'ticketId' = $1 ORDER BY id",
          [ticketId],
        )
      ).rows.map((r) => r.datos.data);
    const lineaDe = (
      r: { body: { lineas: Array<{ codigo: string; id: string; cantidad: number }> } },
      prefijo: string,
    ) => r.body.lineas.find((l) => l.codigo.startsWith(prefijo))!;

    it('las líneas del pedido llegan al ticket (al abrirse y cuando el pedido cambia) y la movilización no va en el reporte', async () => {
      const e = evento({ data: { lineas: lineas() } });
      await consumer.consumir(e);
      const t = await prisma.ticket.findUniqueOrThrow({ where: { pedidoId: e.subject.id } });
      expect(await prisma.ticketLinea.count({ where: { ticketId: t.id } })).toBe(3);
      // el pedido cambia: sube la cantidad de una, baja otra y trae una nueva; la que ya no viene se quita (no tenía días)
      await consumer.consumir(
        actualizado(e.subject.id, {
          lineas: [
            { ...lineas()[0], cantidad: 5 },
            {
              codigo: `NUEVA-${n}`,
              descripcion: 'Nueva',
              unidadMedidaId: porCantidad,
              cantidad: 2,
              tipoLinea: 'servicio',
            },
          ],
        }),
      );
      const filas = await prisma.ticketLinea.findMany({
        where: { ticketId: t.id },
        orderBy: { orden: 'asc' },
      });
      expect(filas.map((f) => [f.codigo, Number(f.cantidad)])).toEqual([
        [`HT-DIA-${n}`, 5],
        [`NUEVA-${n}`, 2],
      ]);
    });

    it('lee el reporte: sin movilización, con lo cotizado y lo reportado; la precarga de un servicio de un solo día aplica lo cotizado', async () => {
      const t = await ticket();
      const r = await ver(t).expect(200);
      expect(r.body.lineas.map((l: { codigo: string }) => l.codigo)).toEqual([
        `HT-DIA-${n}`,
        `HT-CANT-${n}`,
      ]);
      expect(r.body).toMatchObject({ fechaInicio: DIAS[0], fechaFin: DIAS[2], completadoAt: null });
      expect(lineaDe(r, 'HT-DIA')).toMatchObject({
        porDia: true,
        cotizado: 3,
        cantidad: 0,
        dias: [],
      });

      // un servicio de un solo día se precarga con lo cotizado
      const uno = await ticketEnTraslado();
      await admin.query(
        'UPDATE pumping.ticket SET paso_codigo = $2, fecha_inicio_servicio = $3, fecha_fin_servicio = $3 WHERE id = $1',
        [uno.id, 'ejecucion_operativa', DIAS[0]],
      );
      await consumer.consumir(actualizado(uno.pedidoId, { lineas: lineas() }));
      const r1 = await ver(uno).expect(200);
      expect(lineaDe(r1, 'HT-DIA')).toMatchObject({
        cantidad: 3,
        dias: [{ fecha: DIAS[0], estado: 'operacion', cantidad: 3 }],
      });
      expect(lineaDe(r1, 'HT-CANT')).toMatchObject({ cantidad: 10 });
      // la precarga es de una sola vez
      await ver(uno).expect(200);
      expect(
        (
          await admin.query(
            'SELECT count(*)::int AS c FROM pumping.reporte_item_dia d JOIN pumping.ticket_linea l ON l.id = d.linea_id WHERE l.ticket_id = $1',
            [uno.id],
          )
        ).rows[0].c,
      ).toBe(2);
    });

    it('reparte por día: la marca vale 1 en las líneas por día, las demás piden la cantidad, y no pasa de lo cotizado ni sale del servicio', async () => {
      const t = await ticket();
      const r = await ver(t).expect(200);
      const dia = lineaDe(r, 'HT-DIA');
      const cant = lineaDe(r, 'HT-CANT');
      await marcar(t, dia.id, DIAS[0], { estado: 'operacion' }).expect(200);
      await marcar(t, dia.id, DIAS[1], { estado: 'daily_charge' }).expect(200);
      const tercera = await marcar(t, dia.id, DIAS[2], { estado: 'venta' }).expect(200);
      expect(lineaDe(tercera, 'HT-DIA')).toMatchObject({ cantidad: 3 });
      // lo cotizado son 3 días: un cuarto no existe en el servicio, y repetir un día no suma
      expect((await marcar(t, dia.id, '2026-11-08', { estado: 'operacion' })).body.code).toBe(
        'FUERA_DEL_SERVICIO',
      );
      await marcar(t, dia.id, DIAS[0], { estado: 'venta' }).expect(200);
      expect(lineaDe(await ver(t), 'HT-DIA').cantidad).toBe(3);

      // la línea por cantidad pide cuánto se aplicó
      expect((await marcar(t, cant.id, DIAS[0], { estado: 'operacion' })).status).toBe(400);
      await marcar(t, cant.id, DIAS[0], { estado: 'operacion', cantidad: 6 }).expect(200);
      const sobre = await marcar(t, cant.id, DIAS[1], { estado: 'operacion', cantidad: 5 });
      expect(sobre.status).toBe(409);
      expect(sobre.body.code).toBe('CANTIDAD_SUPERA_COTIZADO');
      await marcar(t, cant.id, DIAS[1], { estado: 'operacion', cantidad: 4 }).expect(200);
      // corregir un día no cuenta dos veces
      await marcar(t, cant.id, DIAS[0], { estado: 'venta', cantidad: 6 }).expect(200);
      expect(lineaDe(await ver(t), 'HT-CANT').cantidad).toBe(10);
      // quitar la marca libera la cantidad
      await http()
        .delete(`${url(t)}/lineas/${cant.id}/dias/${DIAS[1]}`)
        .set(op1())
        .expect(200);
      expect(lineaDe(await ver(t), 'HT-CANT').cantidad).toBe(6);
      // una línea de otro ticket no se marca aquí
      const otro = await ticket();
      expect(
        (await marcar(otro, cant.id, DIAS[0], { estado: 'operacion', cantidad: 1 })).status,
      ).toBe(404);
    });

    it('una línea por día admite cuántas personas o piezas fueron ese día (el pedido repite el código y el ticket las suma)', async () => {
      const t = await ticket();
      const dia = lineaDe(await ver(t).expect(200), 'HT-DIA'); // cotizado: 3
      await marcar(t, dia.id, DIAS[0], { estado: 'operacion', cantidad: 2 }).expect(200);
      expect(lineaDe(await ver(t), 'HT-DIA')).toMatchObject({ cantidad: 2 });
      expect(
        (await marcar(t, dia.id, DIAS[1], { estado: 'operacion', cantidad: 2 })).body.code,
      ).toBe('CANTIDAD_SUPERA_COTIZADO');
      expect((await marcar(t, dia.id, DIAS[1], { estado: 'operacion', cantidad: 0 })).status).toBe(
        400,
      );
      await marcar(t, dia.id, DIAS[1], { estado: 'operacion', cantidad: 1 }).expect(200);
      expect(lineaDe(await ver(t), 'HT-DIA').cantidad).toBe(3);
      // sin indicar cantidad, la marca vuelve a valer 1
      await marcar(t, dia.id, DIAS[0], { estado: 'daily_charge' }).expect(200);
      expect(lineaDe(await ver(t), 'HT-DIA').cantidad).toBe(2);
    });

    it('solo el equipo del ticket en la Ejecución operativa lo arma; la base también impide pasarse de lo cotizado', async () => {
      const t = await ticket();
      const dia = lineaDe(await ver(t).expect(200), 'HT-DIA');
      expect((await marcar(t, dia.id, DIAS[0], { estado: 'operacion' }, op2())).status).toBe(200); // OP2 también es del equipo
      const ajeno = como('operador', uuidv7(), 'Otro operador');
      expect((await marcar(t, dia.id, DIAS[1], { estado: 'operacion' }, ajeno)).status).toBe(403);
      // el Supervisor asignado tampoco lo llena: el reporte es del Operador
      expect(
        (await marcar(t, dia.id, DIAS[1], { estado: 'operacion' }, supervisora())).status,
      ).toBe(403);
      expect((await completar(t, supervisora())).status).toBe(403);
      const sinPermiso = como('operador', OP1.id, OP1.nombre, []);
      expect((await marcar(t, dia.id, DIAS[1], { estado: 'operacion' }, sinPermiso)).status).toBe(
        403,
      );
      await admin.query('UPDATE pumping.ticket SET paso_codigo = $2 WHERE id = $1', [
        t.id,
        'traslado_salida',
      ]);
      expect((await marcar(t, dia.id, DIAS[1], { estado: 'operacion' })).status).toBe(409);
      await admin.query('UPDATE pumping.ticket SET paso_codigo = $2 WHERE id = $1', [
        t.id,
        'ejecucion_operativa',
      ]);
      // la base: una celda más allá de lo cotizado se rechaza aunque la API no estuviera
      await expect(
        admin.query(
          "INSERT INTO pumping.reporte_item_dia (id, linea_id, fecha, estado, cantidad, created_by) VALUES ($1, $2, $3, 'operacion', 99, $4)",
          [uuidv7(), dia.id, DIAS[2], OP1.id],
        ),
      ).rejects.toThrow(/pasa de lo cotizado/);
    });

    it('completar exige cantidades y envía a Comercial las líneas reportadas con sus días; tocarlo lo reabre y se completa de nuevo', async () => {
      const t = await ticket();
      const r = await ver(t).expect(200);
      const dia = lineaDe(r, 'HT-DIA');
      const cant = lineaDe(r, 'HT-CANT');
      const vacio = await completar(t);
      expect(vacio.status).toBe(409);
      expect(vacio.body.code).toBe('REPORTE_VACIO');

      await marcar(t, dia.id, DIAS[0], { estado: 'operacion' }).expect(200);
      await marcar(t, dia.id, DIAS[1], { estado: 'operacion' }).expect(200);
      await marcar(t, cant.id, DIAS[1], { estado: 'venta', cantidad: 2.5 }).expect(200);
      const reporteReq = async () =>
        (await requisitosDe(t.id)).find((x) => x.codigo === 'reporte_herramientas_completado');
      expect(await reporteReq()).toMatchObject({ estado: 'pendiente' }); // anotar cantidades no basta: hay que completarlo
      const ok = await completar(t).expect(201);
      expect(ok.body.completadoAt).not.toBeNull();
      expect(await reporteReq()).toMatchObject({ estado: 'cumplido', origen: 'sistema' });
      // sin el reporte completado el ticket no sale de la Ejecución operativa: con él, ese requisito ya no falta

      const [e1] = await eventosDe(t.id);
      expect(e1).toMatchObject({
        ticketId: t.id,
        pedidoId: t.pedidoId,
        supervisorId: SUPERVISORA.id,
        operadorId: OP1.id,
      });
      expect(e1.herramientas).toEqual([
        {
          listaPreciosItemId: null,
          codigo: `HT-DIA-${n}`,
          nombre: 'Herramienta por día',
          unidadMedidaId: porDia,
          cantidad: 2,
          usos: [
            { fecha: DIAS[0], estado: 'operacion', cantidad: 1 },
            { fecha: DIAS[1], estado: 'operacion', cantidad: 1 },
          ],
        },
        {
          listaPreciosItemId: null,
          codigo: `HT-CANT-${n}`,
          nombre: 'Material por cantidad',
          unidadMedidaId: porCantidad,
          cantidad: 2.5,
          usos: [{ fecha: DIAS[1], estado: 'venta', cantidad: 2.5 }],
        },
      ]);

      // tocar el reporte lo reabre; completar de nuevo reenvía la versión nueva
      const reabierto = await marcar(t, dia.id, DIAS[2], { estado: 'operacion' }).expect(200);
      expect(reabierto.body.completadoAt).toBeNull();
      expect(await reporteReq()).toMatchObject({ estado: 'pendiente' }); // tocarlo reabre también el requisito
      await completar(t).expect(201);
      expect(await reporteReq()).toMatchObject({ estado: 'cumplido' });
      const eventos2 = await eventosDe(t.id);
      expect(eventos2).toHaveLength(2);
      expect(eventos2[1].herramientas[0].cantidad).toBe(3);
    });
  });

  describe('cambio de ítems del pedido: propone el Operador, aprueba el Supervisor y Comercial aplica (P7)', () => {
    const LISTA_A = uuidv7();
    const LISTA_B = uuidv7();
    const item = (listaPreciosItemId: string, extra: object = {}) => ({
      listaPreciosItemId,
      codigo: `COD-${listaPreciosItemId.slice(-4)}`,
      descripcion: 'Ítem de la lista del cliente',
      unidadMedidaId: U('Día'),
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

    it('el Jefe de Base propone y decide el cambio de ítems de cualquier ticket, igual que el Supervisor; otro supervisor del ticket ajeno no', async () => {
      const jefeCambios = () =>
        como('jefe_base', JEFE, 'Jaime Jefe de Base', [
          P.PUMPING_VER,
          P.PUMPING_CAMBIOS_SOLICITAR,
          P.PUMPING_CAMBIOS_APROBAR,
          P.PUMPING_JORNADA_CAMBIAR_DURACION,
        ]);
      const t = await ticketEnTraslado();
      // el Jefe de Base no es del equipo del ticket y aun así propone
      const propuesta = await propone(t, valido(), jefeCambios());
      expect(propuesta.status).toBe(201);
      // le aparece en su bandeja de Aprobaciones junto con las de los demás tickets
      const bandeja = await http().get(`${base}/cambios-items/pendientes`).set(jefeCambios());
      expect(bandeja.status).toBe(200);
      expect(bandeja.body.map((x: { id: string }) => x.id)).toContain(propuesta.body.id);
      // y es una tarea del día del Jefe de Base
      const tareasJefe = await http().get(`${base}/mis-tareas-hoy`).set(jefeCambios());
      const delJefe = (
        tareasJefe.body.bloques as Array<{
          rol: string;
          tareas: Array<{ clave: string; ticketId: string | null }>;
        }>
      ).find((b) => b.rol === 'jefe_base');
      expect(
        delJefe?.tareas.some((x) => x.clave === 'aprobar_cambio_items' && x.ticketId === t.id),
      ).toBe(true);
      // un supervisor que no es del ticket no ve ni decide
      const ajeno = como('supervisor_pumping', SUPERVISOR_PUMPING.id, SUPERVISOR_PUMPING.nombre, [
        P.PUMPING_OPERAR,
        P.PUMPING_CAMBIOS_APROBAR,
      ]);
      expect(
        (await http().post(`${base}/cambios-items/${propuesta.body.id}/aprobar`).set(ajeno)).status,
      ).toBe(403);
      // el Jefe de Base aprueba: igual que el Supervisor, queda por aplicar y Comercial recibe el cambio
      const ok = await http()
        .post(`${base}/cambios-items/${propuesta.body.id}/aprobar`)
        .set(jefeCambios());
      expect(ok.status).toBe(201);
      expect(await eventosAprobados(t.id)).toHaveLength(1);
      // y también rechaza (con motivo) una solicitud nueva
      await externos.consumir(resultado(propuesta.body.id, false, 'El pedido ya salió al cliente'));
      const otra = await propone(t, valido(), jefeCambios());
      expect(otra.status).toBe(201);
      expect(
        (
          await http()
            .post(`${base}/cambios-items/${otra.body.id}/rechazar`)
            .set(jefeCambios())
            .send({ motivo: 'No procede' })
        ).status,
      ).toBe(201);
    });

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
      // los ve quien tiene `pumping.documentos.ver` (el equipo y Facturación), aunque no pueda operar tickets
      const facturacion = como('facturacion', uuidv7(), 'Fabiola Facturación', [
        P.PUMPING_DOCUMENTOS_VER,
      ]);
      const lista = await http().get(`${t.url}/documentos`).set(facturacion);
      expect(lista.status).toBe(200);
      expect(lista.body).toHaveLength(2);
      // operar tickets, sin ese permiso, no alcanza
      expect((await http().get(`${t.url}/documentos`).set(supervisora())).status).toBe(403);
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

  // ------------------------------------------------------------------------------------------------------------------
  // Jornadas: un día de operación del ticket (etapas 1 a 3)
  // ------------------------------------------------------------------------------------------------------------------
  describe('Jornadas del ticket: un día de operación', () => {
    const DIAS = ['2026-11-05', '2026-11-06', '2026-11-07'];
    const permisosSup = [
      P.PUMPING_OPERAR,
      P.PUMPING_JORNADA_ACEPTAR_COMPANY_MAN,
      P.PUMPING_JORNADA_CERRAR,
      P.PUMPING_JORNADA_REABRIR,
    ];
    const sup = () => como('supervisor', SUPERVISORA.id, SUPERVISORA.nombre, permisosSup);
    // un supervisor con los permisos pero que no es el asignado a este ticket
    const supAjeno = () =>
      como('supervisor_pumping', SUPERVISOR_PUMPING.id, SUPERVISOR_PUMPING.nombre, permisosSup);
    const jefeBase = () =>
      como('jefe_base', JEFE, 'Jaime Jefe de Base', [P.PUMPING_JORNADA_REABRIR, P.PUMPING_VER]);
    let hoy = DIAS[1];
    beforeAll(() => {
      const svc = app.get(JornadasService) as unknown as { hoy: () => string };
      jest.spyOn(svc, 'hoy').mockImplementation(() => hoy);
    });
    beforeEach(() => {
      hoy = DIAS[1];
    });

    type Ticket = { id: string; url: string; jornadas: string; pedidoId: string };
    const enEjecucion = async (inicio = DIAS[0], fin = DIAS[2]): Promise<Ticket> => {
      const t = await ticketEnTraslado();
      await admin.query(
        'UPDATE pumping.ticket SET paso_codigo = $2, fecha_inicio_servicio = $3, fecha_fin_servicio = $4 WHERE id = $1',
        [t.id, 'ejecucion_operativa', inicio, fin],
      );
      return { ...t, jornadas: `${t.url}/jornadas` };
    };
    const ver = (t: { jornadas: string }, h = op1()) => http().get(t.jornadas).set(h);
    const aceptar = (t: { jornadas: string }, f: string, h = sup()) =>
      http().post(`${t.jornadas}/${f}/aceptacion-company-man`).set(h);
    const sinOp = (t: { jornadas: string }, f: string, cuerpo: object, h = op1()) =>
      http().post(`${t.jornadas}/${f}/sin-operacion`).set(h).send(cuerpo);
    const cerrar = (t: { jornadas: string }, f: string, h = sup()) =>
      http().post(`${t.jornadas}/${f}/cerrar`).set(h);
    const reabrir = (t: { jornadas: string }, f: string, cuerpo: object, h = jefeBase()) =>
      http().post(`${t.jornadas}/${f}/reabrir`).set(h).send(cuerpo);
    const motivo = async (codigo = 'clima') =>
      (
        await admin.query('SELECT id FROM pumping.cat_motivo_sin_operacion WHERE codigo = $1', [
          codigo,
        ])
      ).rows[0].id as string;
    const estados = (r: { body: { jornadas: Array<{ estadoVisible: string }> } }) =>
      r.body.jornadas.map((j) => j.estadoVisible);
    const requisitosDe = async (ticketId: string, fecha?: string) =>
      (
        await admin.query(
          `SELECT r.requisito_codigo AS codigo, r.estado, r.fecha::text AS fecha, q.momento, q.modulo
             FROM pumping.ticket_requisito r JOIN pumping.requisito q ON q.codigo = r.requisito_codigo
            WHERE r.ticket_id = $1 AND r.fecha IS NOT NULL ${fecha ? 'AND r.fecha = $2' : ''}
            ORDER BY r.fecha, r.requisito_codigo`,
          fecha ? [ticketId, fecha] : [ticketId],
        )
      ).rows as Array<{
        codigo: string;
        estado: string;
        fecha: string;
        momento: string;
        modulo: string;
      }>;
    const estadoReq = async (ticketId: string, fecha: string, codigo: string) =>
      (await requisitosDe(ticketId, fecha)).find((f) => f.codigo === codigo)?.estado;

    /** Llena el checklist de seguridad de un día por su pantalla: confirmaciones, lecturas seguras de los cuatro gases y todo el LOTO. */
    const completarChecklist = async (t: { url: string }, fecha: string) => {
      const url = `${t.url}/ingreso/${fecha}`;
      await http()
        .patch(url)
        .set(op1())
        .send({
          toolboxTalkRealizado: true,
          walkaroundCompletado: true,
          lineaBaseAmbientalDocumentada: true,
          rutasEmergenciaVerificadas: true,
          simopsConfirmado: true,
        })
        .expect(200);
      for (const l of [
        { gas: 'h2s', lectura: 3 },
        { gas: 'lel', lectura: 0 },
        { gas: 'o2', lectura: 20.9 },
        { gas: 'co', lectura: 5 },
      ]) {
        await http().patch(url).set(op1()).send({ nuevaLectura: l }).expect(200);
      }
      const antes = (await http().get(url).set(op1()).expect(200)).body;
      for (const l of antes.loto)
        await http().patch(`${url}/loto/${l.itemId}`).set(op1()).expect(200);
      return (await http().get(url).set(op1()).expect(200)).body;
    };
    /** Marca una herramienta usada ese día (en la base: el reparto por la pantalla ya tiene sus pruebas en otro bloque). */
    const marcarHerramienta = async (t: { id: string }, fecha: string) => {
      let linea = (
        await admin.query('SELECT id FROM pumping.ticket_linea WHERE ticket_id = $1 LIMIT 1', [
          t.id,
        ])
      ).rows[0]?.id as string | undefined;
      if (!linea) {
        linea = uuidv7();
        const um = (
          await admin.query('SELECT id FROM catalogos.unidad_medida ORDER BY nombre LIMIT 1')
        ).rows[0].id;
        await admin.query(
          "INSERT INTO pumping.ticket_linea (id, ticket_id, orden, codigo, descripcion, unidad_medida_id, cantidad, tipo_linea) VALUES ($1, $2, 1, $3, 'Herramienta de prueba', $4, 10, 'herramienta')",
          [linea, t.id, `JR-${n}`, um],
        );
      }
      await admin.query(
        "INSERT INTO pumping.reporte_item_dia (id, linea_id, fecha, estado, cantidad, created_by) VALUES ($1, $2, $3, 'operacion', 1, $4)",
        [uuidv7(), linea, fecha, JEFE],
      );
    };
    /** Cumple lo que pide el cierre de un día: el job log completado (por su pantalla) y una herramienta marcada. */
    const cumplirCierre = async (t: Ticket, fecha: string) => {
      const dia = `${t.url}/reportes-diarios/${fecha}`;
      await http()
        .put(dia)
        .set(op1())
        .send({
          actividades: [{ horaInicio: '06:00', horaFin: '09:30', detalle: 'Armado de líneas' }],
        })
        .expect(200);
      await http().post(`${dia}/completar`).set(op1()).expect(201);
      await marcarHerramienta(t, fecha);
      await cumplirLlegada(t, fecha);
      await ver(t).expect(200); // pedir las jornadas deja los requisitos al día
    };
    const UNIDADES_DEL_TICKET = [
      { v: VEHICULO, o: OP1 },
      { v: VEHICULO_2, o: OP2 },
    ];
    /** Los traslados de salida de un día, por cada unidad: Flota inspecciona, aprueba y autoriza el viaje; el operador firma el reporte de unidad. */
    const cumplirSalida = async (t: Ticket, fecha: string) => {
      for (const { v, o } of UNIDADES_DEL_TICKET) {
        const ev = (tipo: string, extra: Record<string, unknown> = {}) =>
          externos.consumir(
            externo(
              tipo,
              { ticketId: t.id, unidadId: v.unidadId, diaServicio: fecha, ...extra },
              'flota',
            ),
          );
        await ev('flota.inspeccion_vehiculo.realizada');
        await ev('flota.inspeccion_vehiculo.aprobada');
        await ev('flota.gerenciamiento_viaje.aprobado', { tipo: 'salida' });
        await admin.query(
          `INSERT INTO pumping.reporte_unidad (id, ticket_id, unidad_id, fecha, origen, destino, salida_fecha, salida_combustible, salida_firmada_por, salida_firmada_at)
           VALUES ($1, $2, $3, $4::date, 'Base Coco', 'Pozo Beta-9', $4::date, 80, $5, now())
           ON CONFLICT (ticket_id, unidad_id, fecha) DO UPDATE SET salida_firmada_por = $5, salida_firmada_at = now()`,
          [uuidv7(), t.id, v.unidadId, fecha, o.id],
        );
      }
    };
    /** Los traslados de llegada de un día, por cada unidad: el operador firma el reporte de llegada y Flota autoriza el viaje de retorno. */
    const cumplirLlegada = async (t: Ticket, fecha: string) => {
      for (const { v, o } of UNIDADES_DEL_TICKET) {
        await externos.consumir(
          externo(
            'flota.gerenciamiento_viaje.aprobado',
            { ticketId: t.id, unidadId: v.unidadId, diaServicio: fecha, tipo: 'retorno' },
            'flota',
          ),
        );
        await admin.query(
          `UPDATE pumping.reporte_unidad
              SET llegada_fecha = $3::date, llegada_combustible = 20, unidad_lista = true, operacion_interrumpida = false,
                  llegada_firmada_por = $4, llegada_firmada_at = now()
            WHERE ticket_id = $1 AND unidad_id = $2 AND fecha = $3::date`,
          [t.id, v.unidadId, fecha, o.id],
        );
      }
    };
    /** Lo que exige cada día, en el orden en que lo muestra la jornada: la apertura primero y por código. Los de traslado son uno por unidad (2). */
    const APERTURA_DIA = [
      'art_vigente',
      'checklist_seguridad_dia',
      'company_man_acepto_dia',
      ...Array(2).fill('gerenciamiento_salida_dia'),
      ...Array(2).fill('inspeccion_aprobada_dia'),
      ...Array(2).fill('inspeccion_vehiculo_dia'),
      'pt_dia_cargado',
      'ptw_dia_aprobado',
      ...Array(2).fill('reporte_unidad_salida_dia'),
      'sin_swa_dia',
    ];
    /** El cierre del día ya no exige la llegada: el retorno es del Control de retorno y el reporte de llegada, del Traslado de llegada. */
    const CIERRE_DIA = ['herramientas_dia', 'job_log_dia'];
    const mas = (fecha: string, dias: number) =>
      new Date(Date.parse(`${fecha}T00:00:00Z`) + dias * 86_400_000).toISOString().slice(0, 10);
    /** Lo que QHSE hace por día llega a Pumping como eventos: el PTW aprobado y los documentos PT y ART cargados (el ART vale 15 días). Devuelven el id de origen. */
    const aprobarPtw = async (t: Ticket, fecha: string) => {
      const ptwId = uuidv7();
      await externos.consumir(
        externo('qhse.ptw.cerrado', {
          ptwId,
          ticketId: t.id,
          pedidoId: t.pedidoId,
          diaOperacion: fecha,
        }),
      );
      return ptwId;
    };
    const cargarDocumento = async (
      t: Ticket,
      tipoDocumento: 'pt' | 'art',
      fecha: string,
      vigenteHasta?: string,
    ) => {
      const documentoId = uuidv7();
      await externos.consumir(
        externo('qhse.documento_pedido.cargado', {
          documentoId,
          tipoDocumento,
          ticketId: t.id,
          pedidoId: t.pedidoId,
          fecha,
          ...(tipoDocumento === 'art' ? { vigenteHasta: vigenteHasta ?? mas(fecha, 15) } : {}),
        }),
      );
      return documentoId;
    };
    /** QHSE cubre un día completo: PTW aprobado, PT cargado y un ART vigente. */
    const cubrirQhse = async (t: Ticket, fecha: string) => {
      await aprobarPtw(t, fecha);
      await cargarDocumento(t, 'pt', fecha);
      await cargarDocumento(t, 'art', fecha);
    };
    /** Deja un día listo para trabajar: el Company Man aceptó, el checklist del día está completo y QHSE lo cubrió, así que la jornada queda abierta. */
    const abrirDia = async (t: Ticket, fecha: string) => {
      await aceptar(t, fecha).expect(201);
      await completarChecklist(t, fecha);
      await cumplirSalida(t, fecha);
      await cubrirQhse(t, fecha);
    };

    it('al pedirlas en la Ejecución operativa se crea una jornada por día del rango y el estado de hoy se deduce de la fecha', async () => {
      const t = await enEjecucion();
      const r = await ver(t).expect(200);
      expect(r.body).toMatchObject({
        hoy: DIAS[1],
        total: 3,
        diaActual: 2,
        cerradas: 0,
        sinOperacion: 0,
        fechaInicio: DIAS[0],
        fechaFin: DIAS[2],
      });
      expect(
        r.body.jornadas.map((j: { fecha: string; numero: number }) => [j.fecha, j.numero]),
      ).toEqual([
        [DIAS[0], 1],
        [DIAS[1], 2],
        [DIAS[2], 3],
      ]);
      // hoy falta lo de QHSE (PTW, PT y ART): el día se ve bloqueado
      expect(estados(r)).toEqual(['con_pendientes', 'bloqueada', 'pendiente']);
      // pedirlas otra vez no duplica
      await ver(t).expect(200);
      expect(await prisma.ticketJornada.count({ where: { ticketId: t.id } })).toBe(3);
      // hoy no es día del servicio
      hoy = '2026-12-01';
      expect((await ver(t)).body.diaActual).toBeNull();
    });

    it('antes de la Ejecución operativa todavía no hay jornadas, y sin permiso no se ven', async () => {
      const t = await ticketEnTraslado();
      const r = await http().get(`${t.url}/jornadas`).set(op1()).expect(200);
      expect(r.body).toMatchObject({ total: 0, jornadas: [] });
      expect(await prisma.ticketJornada.count({ where: { ticketId: t.id } })).toBe(0);
      const e = await enEjecucion();
      expect((await http().get(e.jornadas).set(sinPermiso())).status).toBe(403);
    });

    it('el catálogo de motivos de un día sin operación está sembrado', async () => {
      const r = await http().get(`${base}/jornadas/motivos-sin-operacion`).set(op1()).expect(200);
      expect(r.body.map((m: { codigo: string }) => m.codigo)).toEqual([
        'clima',
        'espera_cliente',
        'falla_equipo',
        'orden_cliente',
        'otro',
      ]);
    });

    it('la aceptación del Company Man la marca el Supervisor asignado, el mismo día; con el checklist del día completo la jornada queda abierta', async () => {
      const t = await enEjecucion();
      await ver(t);
      expect((await aceptar(t, DIAS[1], op1())).status).toBe(403); // el operador no tiene el permiso
      expect((await aceptar(t, DIAS[1], supAjeno())).status).toBe(403); // tiene el permiso pero no es el asignado
      expect((await aceptar(t, DIAS[2])).status).toBe(409); // un día futuro
      expect((await aceptar(t, DIAS[0])).status).toBe(409); // un día pasado
      expect((await aceptar(t, '2026-11-09')).status).toBe(404); // fuera del servicio
      expect((await aceptar(t, 'hoy')).status).toBe(400);
      expect((await aceptar(t, '2026-02-31')).status).toBe(400); // no existe en el calendario
      const r = await aceptar(t, DIAS[1]).expect(201);
      // falta el checklist de seguridad del día: la jornada todavía no se abre
      expect(r.body).toMatchObject({ ok: true, yaMarcada: false, abierta: false });
      expect((await aceptar(t, DIAS[1])).body.yaMarcada).toBe(true); // marcarla otra vez no cambia nada
      expect((await ver(t)).body.jornadas[1]).toMatchObject({
        estado: 'pendiente',
        companyManAcepto: true,
        companyManAceptoPor: SUPERVISORA.id,
        pendientes: { apertura: 12, cierre: 2 }, // checklist, PTW, PT y ART, y por cada unidad la inspección (realizada y aprobada), el reporte de salida y el viaje
      });
      // con el checklist del día completo todavía falta lo de QHSE; cuando QHSE cubre el día, el sistema abre la jornada
      await completarChecklist(t, DIAS[1]);
      expect((await ver(t)).body.jornadas[1]).toMatchObject({
        estado: 'pendiente',
        pendientes: { apertura: 11, cierre: 2 },
      });
      // los traslados de salida de cada unidad: Flota inspecciona, aprueba y autoriza el viaje, y el operador firma el reporte
      await cumplirSalida(t, DIAS[1]);
      expect((await ver(t)).body.jornadas[1]).toMatchObject({
        estado: 'pendiente',
        pendientes: { apertura: 3, cierre: 2 },
      });
      await cubrirQhse(t, DIAS[1]);
      const hoyJ = (await ver(t)).body.jornadas[1];
      expect(hoyJ).toMatchObject({
        estado: 'abierta',
        estadoVisible: 'abierta',
        pendientes: { apertura: 0, cierre: 2 },
      });
      expect(
        (await prisma.ticketJornadaHistorial.findMany({ where: { jornadaId: hoyJ.id } })).map(
          (h) => [h.accion, h.actorId],
        ),
      ).toEqual([['abierta', null]]); // la abrió el sistema al llegar lo último (el aviso de QHSE), sin persona
    });

    it('un día sin operación pide motivo del catálogo y detalle, lo registra quien opera el servicio y no se registra en un día futuro', async () => {
      const t = await enEjecucion();
      await ver(t);
      const m = await motivo();
      const cuerpo = { motivoId: m, detalle: 'Lluvia fuerte en la locación, el cliente suspendió' };
      const ajeno = como('operador', OPERADOR_QUE_ACTUA, 'Oscar Operador');
      expect((await sinOp(t, DIAS[1], cuerpo, ajeno)).status).toBe(403); // no es del ticket
      expect((await sinOp(t, DIAS[1], { motivoId: m, detalle: 'ab' })).status).toBe(400);
      expect(
        (await sinOp(t, DIAS[1], { motivoId: uuidv7(), detalle: 'Detalle válido' })).status,
      ).toBe(400);
      expect((await sinOp(t, DIAS[1], { detalle: 'Detalle válido' })).status).toBe(400);
      expect((await sinOp(t, DIAS[2], cuerpo)).status).toBe(409); // todavía no llega
      await sinOp(t, DIAS[1], cuerpo).expect(201);
      const r = await ver(t);
      expect(r.body).toMatchObject({ sinOperacion: 1 });
      expect(r.body.jornadas[1]).toMatchObject({
        estado: 'sin_operacion',
        estadoVisible: 'sin_operacion',
        sinOperacion: {
          motivo: { codigo: 'clima' },
          detalle: cuerpo.detalle,
          registradoPor: OP1.id,
        },
      });
      // una jornada sin operación ya no se acepta, no se cierra y no admite checklist
      expect((await aceptar(t, DIAS[1])).status).toBe(409);
      expect((await cerrar(t, DIAS[1])).status).toBe(409);
      expect(
        (
          await http()
            .patch(`${t.url}/ingreso/${DIAS[1]}`)
            .set(op1())
            .send({ toolboxTalkRealizado: true })
        ).status,
      ).toBe(409);
      // el pasado también se puede registrar (un día que se olvidó)
      await sinOp(t, DIAS[0], {
        motivoId: await motivo('otro'),
        detalle: 'Espera de permisos del cliente',
      }).expect(201);
    });

    it('solo se cierra una jornada abierta y nunca la de un día que todavía no llega', async () => {
      const t = await enEjecucion();
      await ver(t);
      expect((await cerrar(t, DIAS[1])).status).toBe(409); // todavía no está abierta
      await abrirDia(t, DIAS[1]);
      expect((await cerrar(t, DIAS[1], op1())).status).toBe(403);
      expect((await cerrar(t, DIAS[1], supAjeno())).status).toBe(403);
      await cumplirCierre(t, DIAS[1]);
      await cerrar(t, DIAS[1]).expect(201);
      const r = await ver(t);
      expect(r.body).toMatchObject({ cerradas: 1 });
      expect(r.body.jornadas[1]).toMatchObject({
        estado: 'cerrada',
        estadoVisible: 'cerrada',
        cerradaPor: SUPERVISORA.id,
      });
      expect((await cerrar(t, DIAS[1])).status).toBe(409); // ya cerrada
      // un día futuro: aunque se acepte al Company Man ese día, no se cierra (decisión del cliente)
      hoy = DIAS[2];
      await aceptar(t, DIAS[2]).expect(201);
      hoy = DIAS[1];
      expect((await cerrar(t, DIAS[2])).status).toBe(409);
    });

    it('reabrir pide motivo, solo aplica a una jornada cerrada o sin operación y queda en la bitácora', async () => {
      const t = await enEjecucion();
      await ver(t);
      await abrirDia(t, DIAS[1]);
      await cumplirCierre(t, DIAS[1]);
      await cerrar(t, DIAS[1]).expect(201);
      expect((await reabrir(t, DIAS[1], { motivo: 'ab' })).status).toBe(400);
      expect(
        (await reabrir(t, DIAS[1], { motivo: 'Faltó registrar una actividad' }, op1())).status,
      ).toBe(403);
      await reabrir(t, DIAS[1], { motivo: 'Faltó registrar una actividad' }).expect(201);
      const jornada = (await ver(t)).body.jornadas[1];
      // tenía todos sus requisitos de apertura: vuelve abierta, sin datos de cierre
      expect(jornada).toMatchObject({
        estado: 'abierta',
        cerradaAt: null,
        cerradaPor: null,
        companyManAcepto: true,
      });
      expect((await reabrir(t, DIAS[1], { motivo: 'Otra vez sin necesidad' })).status).toBe(409); // ya está abierta
      expect(
        (
          await prisma.ticketJornadaHistorial.findMany({
            where: { jornadaId: jornada.id },
            orderBy: { createdAt: 'asc' },
          })
        ).map((h) => [h.accion, h.motivo]),
      ).toEqual([
        ['abierta', null],
        ['cerrada', null],
        ['reabierta', 'Faltó registrar una actividad'],
      ]);

      // un día sin operación se reabre y limpia sus datos (queda en la bitácora)
      await sinOp(t, DIAS[0], {
        motivoId: await motivo('falla_equipo'),
        detalle: 'Falló el compresor',
      }).expect(201);
      await reabrir(t, DIAS[0], { motivo: 'Sí hubo operación ese día' }).expect(201);
      expect((await ver(t)).body.jornadas[0]).toMatchObject({
        estado: 'pendiente',
        sinOperacion: null,
      });
    });

    it('si las fechas del servicio cambian, las jornadas se ajustan: las que salen pasan a «no aplica» y las que trabajaron no se tocan', async () => {
      const t = await enEjecucion();
      await ver(t);
      await sinOp(t, DIAS[0], { motivoId: await motivo(), detalle: 'Lluvia el primer día' }).expect(
        201,
      );
      // se acorta a dos días
      await admin.query('UPDATE pumping.ticket SET fecha_fin_servicio = $2 WHERE id = $1', [
        t.id,
        DIAS[1],
      ]);
      let r = await ver(t);
      expect(r.body).toMatchObject({ total: 2 });
      expect(r.body.jornadas.map((j: { estado: string }) => j.estado)).toEqual([
        'sin_operacion',
        'pendiente',
        'no_aplica',
      ]);
      expect((await aceptar(t, DIAS[2])).status).toBe(409); // una jornada «no aplica» no se gestiona
      // se vuelve a ampliar: la jornada recuperada vuelve a ser pendiente
      await admin.query('UPDATE pumping.ticket SET fecha_fin_servicio = $2 WHERE id = $1', [
        t.id,
        '2026-11-08',
      ]);
      r = await ver(t);
      expect(r.body).toMatchObject({ total: 4 });
      expect(
        r.body.jornadas.map((j: { estado: string; numero: number }) => [j.estado, j.numero]),
      ).toEqual([
        ['sin_operacion', 1],
        ['pendiente', 2],
        ['pendiente', 3],
        ['pendiente', 4],
      ]);
      // si el inicio se corre, la numeración sigue al rango y la jornada que ya trabajó se conserva
      await admin.query('UPDATE pumping.ticket SET fecha_inicio_servicio = $2 WHERE id = $1', [
        t.id,
        DIAS[1],
      ]);
      r = await ver(t);
      expect(
        r.body.jornadas.map((j: { fecha: string; numero: number; estado: string }) => [
          j.fecha,
          j.numero,
          j.estado,
        ]),
      ).toEqual([
        [DIAS[0], 1, 'sin_operacion'],
        [DIAS[1], 1, 'pendiente'],
        [DIAS[2], 2, 'pendiente'],
        ['2026-11-08', 3, 'pendiente'],
      ]);
    });

    it('la base exige la coherencia de cada jornada y la bitácora solo se agrega', async () => {
      const t = await enEjecucion();
      await ver(t);
      const j = await prisma.ticketJornada.findFirstOrThrow({
        where: { ticketId: t.id },
        orderBy: { fecha: 'asc' },
      });
      const actualizar = (set: string, valores: unknown[] = []) =>
        admin.query(`UPDATE pumping.ticket_jornada SET ${set} WHERE id = $1`, [j.id, ...valores]);
      await expect(actualizar("estado = 'sin_operacion'")).rejects.toThrow(
        /ticket_jornada_sin_operacion_estado_check/,
      );
      await expect(actualizar("estado = 'abierta'")).rejects.toThrow(
        /ticket_jornada_abierta_check/,
      );
      await expect(actualizar("estado = 'cerrada'")).rejects.toThrow(
        /ticket_jornada_cierre_estado_check/,
      );
      await expect(actualizar('company_man_acepto_at = now()')).rejects.toThrow(
        /ticket_jornada_company_man_check/,
      );
      await expect(actualizar('numero = 0')).rejects.toThrow(/ticket_jornada_numero_check/);
      await expect(
        admin.query(
          'INSERT INTO pumping.ticket_jornada (id, ticket_id, fecha, numero) VALUES ($1, $2, $3, 9)',
          [uuidv7(), t.id, j.fecha.toISOString().slice(0, 10)],
        ),
      ).rejects.toThrow(/ticket_jornada_dia_key/);
      await expect(
        actualizar(
          "estado = 'sin_operacion', sin_operacion_motivo_id = $2, sin_operacion_detalle = 'x', sin_operacion_at = now(), sin_operacion_por = $3",
          [await motivo(), JEFE],
        ),
      ).rejects.toThrow(/ticket_jornada_sin_operacion_detalle_check/);
      // la bitácora: la app puede agregar y leer, no cambiar ni borrar
      const h = uuidv7();
      await prisma.ticketJornadaHistorial.create({
        data: { id: h, jornadaId: j.id, accion: 'abierta', actorId: JEFE },
      });
      await expect(
        prisma.$executeRaw`UPDATE pumping.ticket_jornada_historial SET motivo = 'x' WHERE id = ${h}::uuid`,
      ).rejects.toThrow(/permission denied/);
      await expect(
        prisma.$executeRaw`DELETE FROM pumping.ticket_jornada_historial WHERE id = ${h}::uuid`,
      ).rejects.toThrow(/permission denied/);
    });

    // ----------------------------------------------------------------------------------------------------------------
    // Etapa 2: requisitos por día
    // ----------------------------------------------------------------------------------------------------------------
    it('cada día activo recibe sus requisitos: checklist y aceptación del Company Man para abrir; job log y herramientas para cerrar', async () => {
      const t = await enEjecucion();
      const r = await ver(t).expect(200);
      const filas = await requisitosDe(t.id);
      expect(filas).toHaveLength(48); // 3 días × 16 (7 del día y 9 de traslados por unidad: 4 por unidad y la SWA)
      expect(new Set(filas.map((f) => f.codigo))).toEqual(
        new Set([...APERTURA_DIA, ...CIERRE_DIA]),
      );
      // todo pendiente, salvo «sin SWA»: sin ninguna SWA activa nace cumplido
      expect(filas.filter((f) => f.estado === 'cumplido').map((f) => f.codigo)).toEqual(
        Array(3).fill('sin_swa_dia'),
      );
      // la lista lo muestra por jornada, la apertura primero
      expect(
        r.body.jornadas[1].requisitos.map((q: { codigo: string; momento: string }) => [
          q.codigo,
          q.momento,
        ]),
      ).toEqual([
        ...APERTURA_DIA.map((c) => [c, 'apertura']),
        ...CIERRE_DIA.map((c) => [c, 'cierre']),
      ]);
      expect(r.body.jornadas[1]).toMatchObject({ pendientes: { apertura: 13, cierre: 2 } });
      expect(
        r.body.jornadas[1].bloqueos.map((b: { codigo: string; responsable: string }) => [
          b.codigo,
          b.responsable,
        ]),
      ).toEqual([
        ['art_vigente', 'qhse'],
        ...Array(2).fill(['gerenciamiento_salida_dia', 'flota']),
        ...Array(2).fill(['inspeccion_aprobada_dia', 'flota']),
        ...Array(2).fill(['inspeccion_vehiculo_dia', 'flota']),
        ['pt_dia_cargado', 'qhse'],
        ['ptw_dia_aprobado', 'qhse'],
      ]);
      // pedirlas otra vez no duplica
      await ver(t).expect(200);
      expect(await requisitosDe(t.id)).toHaveLength(48);
      // la lista de requisitos de salida de cada paso no mezcla los de las jornadas
      const estado = await http().get(`${t.url}/requisitos`).set(op1());
      if (estado.status === 200) {
        expect(JSON.stringify(estado.body)).not.toContain('company_man_acepto_dia');
      }
    });

    it('un día sin operación no muestra ni cuenta requisitos y reabrirlo los devuelve', async () => {
      const t = await enEjecucion();
      await ver(t);
      await sinOp(t, DIAS[0], {
        motivoId: await motivo(),
        detalle: 'Lluvia en el primer día',
      }).expect(201);
      expect((await ver(t)).body.jornadas[0]).toMatchObject({
        estadoVisible: 'sin_operacion',
        requisitos: [],
        pendientes: { apertura: 0, cierre: 0 },
      });
      await reabrir(t, DIAS[0], { motivo: 'Sí hubo operación ese día' }).expect(201);
      expect(
        (await ver(t)).body.jornadas[0].requisitos.map((q: { codigo: string }) => q.codigo),
      ).toEqual([...APERTURA_DIA, ...CIERRE_DIA]);
    });

    it('no se cierra la jornada hasta cumplir el job log y las herramientas del día; guardar el job log otra vez lo reabre', async () => {
      const t = await enEjecucion();
      await ver(t);
      await abrirDia(t, DIAS[1]);
      const sinCumplir = await cerrar(t, DIAS[1]);
      expect(sinCumplir.status).toBe(409);
      expect(sinCumplir.body.code).toBe('REQUISITOS_PENDIENTES');
      expect(String(sinCumplir.body.detail)).toContain('Herramientas del día registradas');
      expect(String(sinCumplir.body.detail)).toContain(
        'Reporte diario de actividades (job log) completado',
      );

      // el job log por su pantalla de siempre: al completarlo se cumple el requisito de ese día (y no el de otros días)
      const dia = `${t.url}/reportes-diarios/${DIAS[1]}`;
      const cuerpoJobLog = {
        actividades: [
          {
            horaInicio: '06:00',
            horaFin: '09:30',
            detalle: 'Armado de líneas y prueba de presión',
          },
        ],
      };
      await http().put(dia).set(op1()).send(cuerpoJobLog).expect(200);
      await http().post(`${dia}/completar`).set(op1()).expect(201);
      expect(await estadoReq(t.id, DIAS[1], 'job_log_dia')).toBe('cumplido');
      expect(await estadoReq(t.id, DIAS[0], 'job_log_dia')).toBe('pendiente');
      const soloHerramientas = String((await cerrar(t, DIAS[1])).body.detail);
      expect(soloHerramientas).toContain('Herramientas del día registradas');
      expect(soloHerramientas).not.toContain('job log');
      // guardar de nuevo el día lo reabre: vuelve a faltar el job log
      await http().put(dia).set(op1()).send(cuerpoJobLog).expect(200);
      expect(await estadoReq(t.id, DIAS[1], 'job_log_dia')).toBe('pendiente');
      await http().post(`${dia}/completar`).set(op1()).expect(201);

      // las herramientas: al marcar algo ese día se cumple (se prueba con la marca puesta en la base; el reparto por la pantalla ya tiene sus pruebas)
      await marcarHerramienta(t, DIAS[1]);
      await ver(t);
      expect(await estadoReq(t.id, DIAS[1], 'herramientas_dia')).toBe('cumplido');
      // el cierre del día ya no exige la llegada (reporte de llegada y retorno van en sus pasos)
      await cerrar(t, DIAS[1]).expect(201);
      expect((await ver(t)).body).toMatchObject({ cerradas: 1 });
      // quitar la marca del día deja de cumplirlo
      await admin.query(
        'DELETE FROM pumping.reporte_item_dia WHERE linea_id IN (SELECT id FROM pumping.ticket_linea WHERE ticket_id = $1)',
        [t.id],
      );
      await ver(t);
      expect(await estadoReq(t.id, DIAS[1], 'herramientas_dia')).toBe('pendiente');
    });

    it('lo que falta de otra área bloquea el día de hoy, se informa por área y, al llegar lo último, el sistema abre la jornada solo', async () => {
      const t = await enEjecucion();
      const r = await ver(t).expect(200);
      expect(r.body.jornadas[1]).toMatchObject({
        estadoVisible: 'bloqueada',
        pendientes: { apertura: 13, cierre: 2 },
      });
      // un día futuro no se muestra bloqueado: todavía no toca
      expect(r.body.jornadas[2].estadoVisible).toBe('pendiente');
      expect(r.body.pendientesPorArea).toMatchObject({ qhse: 3, flota: 6, pumping: 6 });

      // el Company Man acepta y el checklist queda completo, pero falta lo de QHSE: la jornada no se abre
      const acepta = await aceptar(t, DIAS[1]).expect(201);
      expect(acepta.body).toMatchObject({ yaMarcada: false, abierta: false });
      await completarChecklist(t, DIAS[1]);
      await cumplirSalida(t, DIAS[1]); // y Flota y el operador cumplieron los traslados de salida
      expect((await ver(t)).body.jornadas[1]).toMatchObject({
        estado: 'pendiente',
        estadoVisible: 'bloqueada',
      });
      expect((await cerrar(t, DIAS[1])).status).toBe(409);

      // QHSE va cumpliendo lo suyo: lo que falta se achica y en cuanto llega lo último el sistema abre la jornada
      const bloqueos = async () =>
        (await ver(t)).body.jornadas[1].bloqueos.map((b: { codigo: string }) => b.codigo);
      await aprobarPtw(t, DIAS[1]);
      expect(await bloqueos()).toEqual(['art_vigente', 'pt_dia_cargado']);
      await cargarDocumento(t, 'pt', DIAS[1]);
      expect(await bloqueos()).toEqual(['art_vigente']);
      await cargarDocumento(t, 'art', DIAS[0]); // emitido el día 1: cubre hasta 15 días
      const abierta = (await ver(t)).body.jornadas[1];
      expect(abierta).toMatchObject({ estado: 'abierta', estadoVisible: 'abierta', bloqueos: [] });
      const bitacora = await prisma.ticketJornadaHistorial.findMany({
        where: { jornadaId: abierta.id },
      });
      expect(bitacora.map((h) => [h.accion, h.actorId])).toEqual([['abierta', null]]); // la abrió el sistema, sin persona
    });

    it('la base mantiene la coherencia de los requisitos por día', async () => {
      const t = await enEjecucion();
      await ver(t);
      const insertar = (codigo: string, fecha: string | null) =>
        admin.query(
          'INSERT INTO pumping.ticket_requisito (id, ticket_id, requisito_codigo, fecha) VALUES ($1, $2, $3, $4)',
          [uuidv7(), t.id, codigo, fecha],
        );
      // un requisito de un día que no es jornada del ticket
      await expect(insertar('job_log_dia', '2030-01-01')).rejects.toThrow(
        /ticket_requisito_jornada_fkey/,
      );
      // el mismo requisito del mismo día no se repite
      await expect(insertar('job_log_dia', DIAS[0])).rejects.toThrow(/ticket_requisito_unico_key/);
      // un requisito de jornada lleva momento y los demás no
      await expect(
        admin.query(
          "INSERT INTO pumping.requisito (codigo, nombre, ambito, modulo) VALUES ('x_prueba', 'x', 'jornada', 'pumping')",
        ),
      ).rejects.toThrow(/requisito_momento_check/);
      await expect(
        admin.query(
          "INSERT INTO pumping.requisito (codigo, nombre, ambito, modulo, momento) VALUES ('x_prueba', 'x', 'ticket', 'pumping', 'cierre')",
        ),
      ).rejects.toThrow(/requisito_momento_check/);
      // borrar la jornada se lleva sus requisitos (la jornada se borra con el ticket)
      const antes = (await requisitosDe(t.id)).length;
      await admin.query('DELETE FROM pumping.ticket_jornada WHERE ticket_id = $1 AND fecha = $2', [
        t.id,
        DIAS[2],
      ]);
      expect((await requisitosDe(t.id)).length).toBe(antes - 16);
    });

    // ----------------------------------------------------------------------------------------------------------------
    // Etapa 3: checklist de seguridad por día
    // ----------------------------------------------------------------------------------------------------------------
    it('cada día tiene su checklist: lo completado un día no vale para otro y el requisito de la jornada lo sigue', async () => {
      const t = await enEjecucion();
      await ver(t);
      const dia1 = await completarChecklist(t, DIAS[0]);
      expect(dia1).toMatchObject({ fecha: DIAS[0], completo: true });
      expect(dia1.lecturas).toHaveLength(4);
      expect(await estadoReq(t.id, DIAS[0], 'checklist_seguridad_dia')).toBe('cumplido');

      // el día siguiente empieza de cero: sin confirmaciones, sin lecturas, con su propio LOTO
      const dia2 = (await http().get(`${t.url}/ingreso/${DIAS[1]}`).set(op1()).expect(200)).body;
      expect(dia2).toMatchObject({
        fecha: DIAS[1],
        completo: false,
        toolboxTalkRealizado: false,
        lecturas: [],
      });
      expect(dia2.loto.every((l: { marcado: boolean }) => !l.marcado)).toBe(true);
      expect(await estadoReq(t.id, DIAS[1], 'checklist_seguridad_dia')).toBe('pendiente');
      expect(await prisma.ticketIngreso.count({ where: { ticketId: t.id } })).toBe(2);

      // desmarcar un ítem del día 1 lo deja incompleto y reabre solo el requisito de ese día
      await http()
        .patch(`${t.url}/ingreso/${DIAS[0]}/loto/${dia1.loto[0].itemId}`)
        .set(op1())
        .expect(200);
      expect(await estadoReq(t.id, DIAS[0], 'checklist_seguridad_dia')).toBe('pendiente');
      await completarChecklist(t, DIAS[1]);
      expect(await estadoReq(t.id, DIAS[1], 'checklist_seguridad_dia')).toBe('cumplido');
      expect(await estadoReq(t.id, DIAS[0], 'checklist_seguridad_dia')).toBe('pendiente');
    });

    it('el checklist de un día solo se llena ese día o después, en una jornada activa del servicio y por el Operador del ticket', async () => {
      const t = await enEjecucion();
      await ver(t);
      const confirmar = { toolboxTalkRealizado: true };
      const patch = (f: string, h = op1()) =>
        http().patch(`${t.url}/ingreso/${f}`).set(h).send(confirmar);
      expect((await patch(DIAS[2])).status).toBe(409); // el día todavía no llega
      expect((await patch('2026-11-09')).status).toBe(404); // fuera del servicio
      expect((await patch('hoy')).status).toBe(400);
      expect((await patch('2026-02-31')).status).toBe(400);
      expect((await http().get(`${t.url}/ingreso/2026-11-09`).set(op1())).status).toBe(404);
      expect(
        (await patch(DIAS[1], como('operador', OPERADOR_QUE_ACTUA, 'Oscar Operador'))).status,
      ).toBe(403); // no es del ticket
      expect((await patch(DIAS[1], sup())).status).toBe(403); // el checklist lo llena el Operador
      expect((await patch(DIAS[1])).status).toBe(200);
      expect((await patch(DIAS[0])).status).toBe(200); // un día pasado que se olvidó
      // una jornada cerrada ya no admite checklist
      await abrirDia(t, DIAS[1]);
      await cumplirCierre(t, DIAS[1]);
      await cerrar(t, DIAS[1]).expect(201);
      expect((await patch(DIAS[1])).status).toBe(409);
    });

    it('la ruta anterior, sin fecha, sigue funcionando: trabaja con hoy si es día de servicio y si no con el primer día', async () => {
      const t = await enEjecucion();
      // hoy (DIAS[1]) es día de servicio
      const hoyChecklist = (await http().get(`${t.url}/ingreso`).set(op1()).expect(200)).body;
      expect(hoyChecklist.fecha).toBe(DIAS[1]);
      // fuera del servicio, el primer día
      hoy = '2026-12-01';
      const otro = await enEjecucion('2027-02-01', '2027-02-03');
      expect((await http().get(`${otro.url}/ingreso`).set(op1()).expect(200)).body.fecha).toBe(
        '2027-02-01',
      );
    });

    it('la base ata las lecturas y el LOTO al checklist de su día', async () => {
      const t = await enEjecucion();
      await ver(t);
      await completarChecklist(t, DIAS[0]);
      const gas = (fecha: string) =>
        admin.query(
          "INSERT INTO pumping.ticket_ingreso_gas (id, ticket_id, fecha, gas, lectura, seguro, medido_por) VALUES ($1, $2, $3, 'h2s', 1, true, $4)",
          [uuidv7(), t.id, fecha, JEFE],
        );
      await gas(DIAS[0]); // el día tiene su checklist
      await expect(gas('2031-01-01')).rejects.toThrow(/ticket_ingreso_gas_ingreso_fkey/); // un día sin checklist
      // borrar el checklist de un día se lleva sus lecturas y su LOTO, no los de otros días
      await http().get(`${t.url}/ingreso/${DIAS[1]}`).set(op1()).expect(200);
      await admin.query('DELETE FROM pumping.ticket_ingreso WHERE ticket_id = $1 AND fecha = $2', [
        t.id,
        DIAS[0],
      ]);
      expect(
        (
          await admin.query(
            'SELECT count(*)::int AS c FROM pumping.ticket_ingreso_gas WHERE ticket_id = $1',
            [t.id],
          )
        ).rows[0].c,
      ).toBe(0);
      expect(
        (
          await admin.query(
            'SELECT count(*)::int AS c FROM pumping.ticket_ingreso_loto WHERE ticket_id = $1',
            [t.id],
          )
        ).rows[0].c,
      ).toBe(4); // el del otro día
    });

    // ----------------------------------------------------------------------------------------------------------------
    // Etapa 4: salida de la Ejecución operativa por jornadas
    // ----------------------------------------------------------------------------------------------------------------
    /** El ticket sale de la ejecución solo con el Reporte de Herramientas completo (aquí se da por cumplido) y las jornadas resueltas. */
    const reporteCompleto = (t: { id: string }) =>
      prisma.ticketRequisito.updateMany({
        where: { ticketId: t.id, requisitoCodigo: 'reporte_herramientas_completado' },
        data: { estado: 'cumplido', cumplidoAt: new Date(), origen: 'sistema' },
      });
    const avanzar = (t: { url: string }) =>
      http().post(`${t.url}/avanzar`).set(op1()).send({ hacia: 'control_retorno' });

    it('el ticket no sale de la Ejecución operativa mientras haya jornadas por cerrar hasta hoy; los días que aún no llegan no se exigen', async () => {
      const t = await enEjecucion(); // el reloj de la prueba marca el día 2
      await reporteCompleto(t);
      const r0 = await ver(t);
      expect(r0.body).toMatchObject({ total: 3, porCerrar: 3 });
      const bloqueado = await avanzar(t).expect(409);
      expect(bloqueado.body.code).toBe('JORNADAS_PENDIENTES');
      // el día 3 todavía no llega: no figura entre lo que falta
      expect(bloqueado.body.detail).toContain(
        'Faltan jornadas por cerrar: Día 1 (05/11); Día 2 (06/11).',
      );

      // el día 1 sin operación, el día 2 (hoy) trabajado y cerrado
      await sinOp(t, DIAS[0], { motivoId: await motivo(), detalle: 'Lluvia el primer día' }).expect(
        201,
      );
      await abrirDia(t, DIAS[1]);
      await cumplirCierre(t, DIAS[1]);
      await cerrar(t, DIAS[1]).expect(201);
      expect((await ver(t)).body).toMatchObject({ porCerrar: 1, cerradas: 1, sinOperacion: 1 });

      // con hoy registrado ya puede continuar con el ciclo de hoy; el servicio no se acorta y el día 3 sigue pendiente para cuando llegue
      await avanzar(t).expect(201);
      expect(
        (
          await admin.query(
            'SELECT paso_codigo, fecha_fin_servicio::text AS fin FROM pumping.ticket WHERE id = $1',
            [t.id],
          )
        ).rows[0],
      ).toEqual({ paso_codigo: 'control_retorno', fin: DIAS[2] });
      expect(
        (
          await admin.query(
            'SELECT fecha::text AS fecha, estado FROM pumping.ticket_jornada WHERE ticket_id = $1 ORDER BY fecha',
            [t.id],
          )
        ).rows.map((j) => `${j.fecha}:${j.estado}`),
      ).toEqual([`${DIAS[0]}:sin_operacion`, `${DIAS[1]}:cerrada`, `${DIAS[2]}:pendiente`]);
      expect(
        (
          await admin.query(
            "SELECT 1 FROM msg_operaciones.outbox WHERE tipo = 'operaciones.pumping.duracion_servicio_cambiada' AND datos->'data'->>'ticketId' = $1",
            [t.id],
          )
        ).rows,
      ).toHaveLength(0);
    });

    it('cada día recorre el ciclo hasta la revisión final: de ahí se cierra solo con todos los días resueltos; si quedan días, el ticket vuelve a la ejecución', async () => {
      const t = await enEjecucion();
      await ver(t);
      await sinOp(t, DIAS[0], { motivoId: await motivo(), detalle: 'Lluvia el primer día' }).expect(
        201,
      );
      await abrirDia(t, DIAS[1]);
      await cumplirCierre(t, DIAS[1]);
      await cerrar(t, DIAS[1]).expect(201);
      await admin.query("UPDATE pumping.ticket SET paso_codigo = 'revision_final' WHERE id = $1", [
        t.id,
      ]);
      const desdeFinal = (hacia: string) =>
        http().post(`${t.url}/avanzar`).set(supervisora()).send({ hacia });
      // el día 3 sigue sin resolver: no se cierra
      const sinCerrar = await desdeFinal('cierre').expect(409);
      expect(sinCerrar.body.code).toBe('JORNADAS_PENDIENTES');
      expect(sinCerrar.body.detail).toContain('Día 3 (07/11)');
      // y el ticket pasa a esperar el siguiente día en la ejecución (sin exigir el Acta, que es del cierre)
      await desdeFinal('ejecucion_operativa').expect(201);
      expect(
        (await admin.query('SELECT paso_codigo FROM pumping.ticket WHERE id = $1', [t.id])).rows[0]
          .paso_codigo,
      ).toBe('ejecucion_operativa');
      // el ciclo de hoy ya se completó: no se puede salir de la ejecución otra vez sin trabajar un día nuevo
      await reporteCompleto(t);
      const repetido = await avanzar(t).expect(409);
      expect(repetido.body.code).toBe('JORNADAS_PENDIENTES');
      expect(repetido.body.detail).toContain('Ya se completó el ciclo hasta el 06/11');
      expect(repetido.body.detail).toContain('Día 3 (07/11)');
      // si el servicio se acorta (el día 3 ya no aplica), no quedan días por trabajar: solo queda cerrar
      await admin.query('UPDATE pumping.ticket SET fecha_fin_servicio = $2 WHERE id = $1', [
        t.id,
        DIAS[1],
      ]);
      await admin.query("UPDATE pumping.ticket SET paso_codigo = 'revision_final' WHERE id = $1", [
        t.id,
      ]);
      const sinDias = await desdeFinal('ejecucion_operativa').expect(409);
      expect(sinDias.body.code).toBe('SIN_DIAS_POR_TRABAJAR');
      expect((await desdeFinal('cierre').expect(409)).body.detail).toContain(
        'Acta de Entrega de Locación',
      );
    });

    it('para salir de la Ejecución operativa hace falta al menos una jornada registrada, aunque todas las demás sean futuras', async () => {
      const t = await enEjecucion(DIAS[2], DIAS[2]); // el servicio empieza mañana
      await reporteCompleto(t);
      await ver(t);
      const r = await avanzar(t).expect(409);
      expect(r.body.code).toBe('JORNADAS_PENDIENTES');
      expect(r.body.detail).toContain('Registre al menos la jornada de hoy');
    });

    it('si el servicio se acorta a mano, el día que sobra tampoco estorba', async () => {
      const t = await enEjecucion();
      await reporteCompleto(t);
      await sinOp(t, DIAS[0], { motivoId: await motivo(), detalle: 'Lluvia el primer día' }).expect(
        201,
      );
      await abrirDia(t, DIAS[1]);
      await cumplirCierre(t, DIAS[1]);
      await cerrar(t, DIAS[1]).expect(201);
      await admin.query('UPDATE pumping.ticket SET fecha_fin_servicio = $2 WHERE id = $1', [
        t.id,
        DIAS[1],
      ]);
      expect((await ver(t)).body).toMatchObject({ total: 2, porCerrar: 0 });
      await avanzar(t).expect(201);
      expect(
        (await admin.query('SELECT paso_codigo FROM pumping.ticket WHERE id = $1', [t.id])).rows[0]
          .paso_codigo,
      ).toBe('control_retorno');
    });

    it('además de las jornadas se sigue exigiendo el Reporte de Herramientas completo, y el aviso dice qué falta', async () => {
      const t = await enEjecucion();
      await ver(t);
      await admin.query(
        "UPDATE pumping.ticket_jornada SET estado = 'cerrada', cerrada_at = now(), cerrada_por = $2 WHERE ticket_id = $1",
        [t.id, JEFE],
      );
      const falta = await avanzar(t).expect(409);
      expect(falta.body.code).toBe('REQUISITOS_PENDIENTES');
      expect(falta.body.detail).toContain('Reporte de herramientas completado');
      expect(falta.body.detail).not.toContain('Checklist de ingreso');
      expect(falta.body.detail).not.toContain('Formalización');
      await reporteCompleto(t);
      await avanzar(t).expect(201);
    });

    // ----------------------------------------------------------------------------------------------------------------
    // Etapa 5a: lo que QHSE hace por día (PTW aprobado, PT cargado, ART vigente) llega por eventos
    // ----------------------------------------------------------------------------------------------------------------
    it('cada hecho de QHSE cubre solo sus días: el PTW y el PT uno, el ART todo su rango; anular el documento deja el día sin cubrir', async () => {
      const t = await enEjecucion();
      await ver(t);
      const ptw = await aprobarPtw(t, DIAS[0]);
      await cargarDocumento(t, 'pt', DIAS[1]);
      const art = await cargarDocumento(t, 'art', DIAS[0], DIAS[1]); // vale los días 1 y 2
      const q = async (codigo: string) => [
        await estadoReq(t.id, DIAS[0], codigo),
        await estadoReq(t.id, DIAS[1], codigo),
        await estadoReq(t.id, DIAS[2], codigo),
      ];
      expect(await q('ptw_dia_aprobado')).toEqual(['cumplido', 'pendiente', 'pendiente']);
      expect(await q('pt_dia_cargado')).toEqual(['pendiente', 'cumplido', 'pendiente']);
      expect(await q('art_vigente')).toEqual(['cumplido', 'cumplido', 'pendiente']);

      // QHSE anula el PTW del día 1 y el ART: vuelven a faltar
      await externos.consumir(
        externo('qhse.ptw.anulado', { ptwId: ptw, ticketId: t.id, diaOperacion: DIAS[0] }),
      );
      // reintegrado como aprobado el PTW del día 1 vuelve a valer; en gabinete todavía no (y se vuelve a anular para seguir)
      await externos.consumir(
        externo('qhse.ptw.reintegrado', {
          ptwId: ptw,
          ticketId: t.id,
          diaOperacion: DIAS[0],
          fase: 'gabinete',
        }),
      );
      expect((await q('ptw_dia_aprobado'))[0]).toBe('pendiente');
      await externos.consumir(
        externo('qhse.ptw.reintegrado', {
          ptwId: ptw,
          ticketId: t.id,
          diaOperacion: DIAS[0],
          fase: 'aprobado',
        }),
      );
      expect((await q('ptw_dia_aprobado'))[0]).toBe('cumplido');
      await externos.consumir(
        externo('qhse.ptw.anulado', { ptwId: ptw, ticketId: t.id, diaOperacion: DIAS[0] }),
      );
      await externos.consumir(
        externo('qhse.documento_pedido.anulado', {
          documentoId: art,
          tipoDocumento: 'art',
          ticketId: t.id,
          fecha: DIAS[0],
          vigenteHasta: DIAS[1],
        }),
      );
      expect(await q('ptw_dia_aprobado')).toEqual(['pendiente', 'pendiente', 'pendiente']);
      expect(await q('art_vigente')).toEqual(['pendiente', 'pendiente', 'pendiente']);
      // un segundo ART que cubra solo el día 3 no cubre los anteriores
      await cargarDocumento(t, 'art', DIAS[2], DIAS[2]);
      expect(await q('art_vigente')).toEqual(['pendiente', 'pendiente', 'cumplido']);
    });

    it('un documento del pedido sin ticket llega al ticket por el pedido; los documentos que no son requisito y los eventos incompletos se ignoran', async () => {
      const t = await enEjecucion();
      await ver(t);
      await externos.consumir(
        externo('qhse.documento_pedido.cargado', {
          documentoId: uuidv7(),
          tipoDocumento: 'pt',
          pedidoId: t.pedidoId,
          fecha: DIAS[1],
        }),
      );
      expect(await estadoReq(t.id, DIAS[1], 'pt_dia_cargado')).toBe('cumplido');
      const hechos = () => prisma.ticketHechoQhse.count({ where: { ticketId: t.id } });
      expect(await hechos()).toBe(1);
      // el SFI o el formato de recepción no son requisito de apertura
      await externos.consumir(
        externo('qhse.documento_pedido.cargado', {
          documentoId: uuidv7(),
          tipoDocumento: 'sfi',
          ticketId: t.id,
          fecha: DIAS[1],
        }),
      );
      // sin fecha, sin origen o de un ticket que no existe: se ignoran sin error
      await externos.consumir(
        externo('qhse.documento_pedido.cargado', {
          documentoId: uuidv7(),
          tipoDocumento: 'pt',
          ticketId: t.id,
        }),
      );
      await externos.consumir(
        externo('qhse.ptw.cerrado', { ticketId: t.id, diaOperacion: DIAS[1] }),
      );
      await externos.consumir(
        externo('qhse.documento_pedido.cargado', {
          documentoId: uuidv7(),
          tipoDocumento: 'pt',
          ticketId: uuidv7(),
          fecha: DIAS[1],
        }),
      );
      expect(await hechos()).toBe(1);
      // el mismo evento dos veces no duplica el hecho
      const doc = uuidv7();
      const repetido = externo('qhse.documento_pedido.cargado', {
        documentoId: doc,
        tipoDocumento: 'pt',
        ticketId: t.id,
        fecha: DIAS[0],
      });
      await externos.consumir(repetido);
      await externos.consumir(repetido);
      expect(await hechos()).toBe(2);
    });

    it('lo que QHSE carga antes de que existan las jornadas se recuerda: al empezar la ejecución los días ya nacen cubiertos', async () => {
      const t = await ticketEnTraslado(); // todavía no hay jornadas
      const ticket: Ticket = { ...t, jornadas: `${t.url}/jornadas` };
      await aprobarPtw(ticket, DIAS[0]);
      await cargarDocumento(ticket, 'pt', DIAS[0]);
      await cargarDocumento(ticket, 'art', DIAS[0]);
      expect(await prisma.ticketJornada.count({ where: { ticketId: t.id } })).toBe(0);
      await admin.query(
        'UPDATE pumping.ticket SET paso_codigo = $2, fecha_inicio_servicio = $3, fecha_fin_servicio = $4 WHERE id = $1',
        [t.id, 'ejecucion_operativa', DIAS[0], DIAS[2]],
      );
      const r = await ver(ticket);
      const deQhse = (j: { bloqueos: Array<{ codigo: string; responsable: string }> }) =>
        j.bloqueos.filter((b) => b.responsable === 'qhse').map((b) => b.codigo);
      expect(deQhse(r.body.jornadas[0])).toEqual([]); // el día 1 ya tiene PTW, PT y ART
      expect(deQhse(r.body.jornadas[1])).toEqual(['pt_dia_cargado', 'ptw_dia_aprobado']); // el ART vale 15 días
    });

    it('una jornada abierta vuelve a pendiente si deja de cumplir un requisito de apertura (QHSE anula el PTW) y queda en la bitácora', async () => {
      const t = await enEjecucion();
      await ver(t);
      await aceptar(t, DIAS[1]).expect(201);
      await completarChecklist(t, DIAS[1]);
      await cumplirSalida(t, DIAS[1]);
      const ptw = await aprobarPtw(t, DIAS[1]);
      await cargarDocumento(t, 'pt', DIAS[1]);
      await cargarDocumento(t, 'art', DIAS[1]);
      expect((await ver(t)).body.jornadas[1].estado).toBe('abierta');

      await externos.consumir(
        externo('qhse.ptw.anulado', { ptwId: ptw, ticketId: t.id, diaOperacion: DIAS[1] }),
      );
      const j = (await ver(t)).body.jornadas[1];
      expect(j).toMatchObject({
        estado: 'pendiente',
        estadoVisible: 'bloqueada',
        bloqueos: [{ codigo: 'ptw_dia_aprobado', responsable: 'qhse' }],
      });
      const bitacora = await prisma.ticketJornadaHistorial.findMany({
        where: { jornadaId: j.id },
        orderBy: { createdAt: 'asc' },
      });
      expect(bitacora.map((h) => [h.accion, h.motivo, h.actorId])).toEqual([
        ['abierta', null, null],
        ['reabierta', 'Dejó de cumplirse: PTW del día aprobado', null],
      ]);
      // un nuevo PTW aprobado la vuelve a abrir
      await aprobarPtw(t, DIAS[1]);
      expect((await ver(t)).body.jornadas[1].estado).toBe('abierta');
      // una jornada cerrada no se toca por lo que pase después
      await cumplirCierre(t, DIAS[1]);
      await cerrar(t, DIAS[1]).expect(201);
      await externos.consumir(
        externo('qhse.documento_pedido.anulado', {
          documentoId: uuidv7(),
          tipoDocumento: 'art',
          ticketId: t.id,
          fecha: DIAS[1],
          vigenteHasta: DIAS[2],
        }),
      );
      expect((await ver(t)).body.jornadas[1].estado).toBe('cerrada');
    });

    // ----------------------------------------------------------------------------------------------------------------
    // Etapa 5b: Pumping avisa a QHSE los días de servicio activos (QHSE abre el PTW de cada día)
    // ----------------------------------------------------------------------------------------------------------------
    it('Pumping avisa a QHSE los días de servicio activos del ticket cada vez que el conjunto cambia', async () => {
      const t = await enEjecucion();
      const avisos = async () =>
        (
          await admin.query(
            "SELECT datos->'data'->'dias' AS dias FROM msg_operaciones.outbox WHERE tipo = 'operaciones.pumping.dias_de_servicio_actualizados' AND datos->'data'->>'ticketId' = $1 ORDER BY id",
            [t.id],
          )
        ).rows.map((r) => r.dias as string[]);
      expect(await avisos()).toEqual([]); // antes de pedir las jornadas todavía no existen
      await ver(t);
      expect(await avisos()).toEqual([[DIAS[0], DIAS[1], DIAS[2]]]);
      await ver(t); // sin cambios: no repite el aviso
      expect(await avisos()).toHaveLength(1);

      // un día sin operación ya no necesita PTW; al reabrirlo vuelve
      await sinOp(t, DIAS[0], {
        motivoId: await motivo(),
        detalle: 'Lluvia en el primer día',
      }).expect(201);
      expect((await avisos()).at(-1)).toEqual([DIAS[1], DIAS[2]]);
      await reabrir(t, DIAS[0], { motivo: 'Sí hubo operación ese día' }).expect(201);
      expect((await avisos()).at(-1)).toEqual([DIAS[0], DIAS[1], DIAS[2]]);

      // si el servicio se acorta, el último día ya no aplica; si se amplía, vuelve
      await admin.query('UPDATE pumping.ticket SET fecha_fin_servicio = $2 WHERE id = $1', [
        t.id,
        DIAS[1],
      ]);
      await ver(t);
      expect((await avisos()).at(-1)).toEqual([DIAS[0], DIAS[1]]);
      await admin.query('UPDATE pumping.ticket SET fecha_fin_servicio = $2 WHERE id = $1', [
        t.id,
        DIAS[2],
      ]);
      await ver(t);
      expect((await avisos()).at(-1)).toEqual([DIAS[0], DIAS[1], DIAS[2]]);
      // el aviso lleva lo que QHSE necesita para ubicar el ticket
      const ultimo = (
        await admin.query(
          "SELECT datos->'data' AS d FROM msg_operaciones.outbox WHERE tipo = 'operaciones.pumping.dias_de_servicio_actualizados' AND datos->'data'->>'ticketId' = $1 ORDER BY id DESC LIMIT 1",
          [t.id],
        )
      ).rows[0].d;
      expect(ultimo).toMatchObject({ ticketId: t.id, pedidoId: t.pedidoId });
    });

    // ----------------------------------------------------------------------------------------------------------------
    // Etapa 7c: los traslados de salida y de llegada se repiten cada día, por unidad
    // ----------------------------------------------------------------------------------------------------------------
    describe('traslados de cada día: la salida y la llegada se exigen en cada jornada, por unidad', () => {
      const bloqueosDe = async (t: Ticket, i: number) =>
        (await ver(t)).body.jornadas[i].bloqueos.map(
          (b: { codigo: string; responsable: string }) => [b.codigo, b.responsable],
        ) as Array<[string, string]>;
      const viaje = (t: Ticket, hecho: string, unidadId: string, fecha: string, extra = {}) =>
        externos.consumir(
          externo(hecho, { ticketId: t.id, unidadId, diaServicio: fecha, ...extra }, 'flota'),
        );

      it('lo que se cumplió un día no cubre al siguiente: cada jornada pide sus traslados', async () => {
        const t = await enEjecucion();
        await ver(t);
        await abrirDia(t, DIAS[1]);
        expect((await ver(t)).body.jornadas[1].estado).toBe('abierta');
        // el día 3 empieza de cero: Flota y los reportes de unidad de ese día todavía no existen
        const faltan = (await bloqueosDe(t, 2)).filter(([, area]) => area === 'flota');
        expect(faltan.map(([c]) => c)).toEqual([
          ...Array(2).fill('gerenciamiento_salida_dia'),
          ...Array(2).fill('inspeccion_aprobada_dia'),
          ...Array(2).fill('inspeccion_vehiculo_dia'),
        ]);
        await cumplirSalida(t, DIAS[2]);
        expect((await bloqueosDe(t, 2)).filter(([, area]) => area === 'flota')).toEqual([]);
        // y lo del día 3 no tocó al día 2
        expect((await ver(t)).body.jornadas[1].estado).toBe('abierta');
      });

      it('una SWA activa bloquea abrir el día y, al cerrarse la última, la jornada se abre sola', async () => {
        const t = await enEjecucion();
        await ver(t);
        await abrirDia(t, DIAS[1]);
        expect((await ver(t)).body.jornadas[1].estado).toBe('abierta');

        await externos.consumir(
          externo('qhse.swa.activado', {
            ticketId: t.id,
            swaId: uuidv7(),
            swaActivasEnTicket: 1,
            sinSwaActivas: false,
          }),
        );
        const j = (await ver(t)).body.jornadas[1];
        expect(j).toMatchObject({ estado: 'pendiente', estadoVisible: 'bloqueada' });
        expect(j.bloqueos.map((b: { codigo: string }) => b.codigo)).toEqual(['sin_swa_dia']);
        // lo mismo en los demás días: la SWA es del servicio
        expect((await bloqueosDe(t, 2)).map(([c]) => c)).toContain('sin_swa_dia');

        await externos.consumir(
          externo('qhse.swa.cerrado', {
            ticketId: t.id,
            swaId: uuidv7(),
            swaActivasEnTicket: 0,
            sinSwaActivas: true,
          }),
        );
        expect((await ver(t)).body.jornadas[1].estado).toBe('abierta');
      });

      it('un rechazo de Flota o una inspección anulada deja el día sin cubrir, y volver a aprobar lo abre', async () => {
        const t = await enEjecucion();
        await ver(t);
        await abrirDia(t, DIAS[1]);
        expect((await ver(t)).body.jornadas[1].estado).toBe('abierta');

        await viaje(t, 'flota.inspeccion_vehiculo.rechazada', VEHICULO.unidadId, DIAS[1]);
        expect(await bloqueosDe(t, 1)).toEqual([['inspeccion_aprobada_dia', 'flota']]);
        expect((await ver(t)).body.jornadas[1].estado).toBe('pendiente');
        // el rechazo del viaje de salida de la otra unidad también
        await viaje(t, 'flota.gerenciamiento_viaje.rechazado', VEHICULO_2.unidadId, DIAS[1], {
          tipo: 'salida',
        });
        expect((await bloqueosDe(t, 1)).map(([c]) => c)).toEqual([
          'gerenciamiento_salida_dia',
          'inspeccion_aprobada_dia',
        ]);
        await viaje(t, 'flota.inspeccion_vehiculo.aprobada', VEHICULO.unidadId, DIAS[1]);
        await viaje(t, 'flota.gerenciamiento_viaje.aprobado', VEHICULO_2.unidadId, DIAS[1], {
          tipo: 'salida',
        });
        expect((await ver(t)).body.jornadas[1].estado).toBe('abierta');
        // anular la inspección realizada deja sin cubrir ese día
        await viaje(t, 'flota.inspeccion_vehiculo.anulada', VEHICULO_2.unidadId, DIAS[1]);
        expect((await bloqueosDe(t, 1)).map(([c]) => c)).toEqual(['inspeccion_vehiculo_dia']);
      });

      it('lo que Flota hace antes de la ejecución se recuerda: el día 1 nace cubierto al crearse las jornadas', async () => {
        const t = await ticketEnTraslado(); // todavía no hay jornadas
        const ticket: Ticket = { ...t, jornadas: `${t.url}/jornadas` };
        for (const v of [VEHICULO, VEHICULO_2]) {
          await viaje(ticket, 'flota.inspeccion_vehiculo.realizada', v.unidadId, DIAS[0]);
          await viaje(ticket, 'flota.inspeccion_vehiculo.aprobada', v.unidadId, DIAS[0]);
          await viaje(ticket, 'flota.gerenciamiento_viaje.aprobado', v.unidadId, DIAS[0], {
            tipo: 'salida',
          });
        }
        expect(await prisma.ticketJornada.count({ where: { ticketId: t.id } })).toBe(0);
        await admin.query(
          'UPDATE pumping.ticket SET paso_codigo = $2, fecha_inicio_servicio = $3, fecha_fin_servicio = $4 WHERE id = $1',
          [t.id, 'ejecucion_operativa', DIAS[0], DIAS[2]],
        );
        const r = await ver(ticket);
        expect(
          r.body.jornadas[0].bloqueos.filter(
            (b: { responsable: string }) => b.responsable === 'flota',
          ),
        ).toEqual([]);
        expect(
          r.body.jornadas[1].bloqueos.filter(
            (b: { responsable: string }) => b.responsable === 'flota',
          ),
        ).toHaveLength(6);
      });
    });

    // ----------------------------------------------------------------------------------------------------------------
    // Etapa 9: «Mis tareas de hoy»
    // ----------------------------------------------------------------------------------------------------------------
    describe('mis tareas de hoy: lo que cada persona debe hacer hoy según su papel en el servicio', () => {
      type Tarea = { clave: string; estado: string; detalle: string | null; titulo: string };
      type Bloque = {
        rol: string;
        ticketId: string | null;
        jornada: unknown;
        pendientes: number;
        tareas: Tarea[];
      };
      const url = `${base}/mis-tareas-hoy`;
      const bloqueDe = async (t: Ticket, rol: string, h: ReturnType<typeof op1>) => {
        const r = await http().get(url).set(h).expect(200);
        return (r.body.bloques as Bloque[]).find((b) => b.ticketId === t.id && b.rol === rol);
      };
      const tarea = (b: Bloque | undefined, clave: string) =>
        b?.tareas.find((x) => x.clave === clave);

      it('el Operador ve los pendientes de hoy de su unidad; lo hecho queda marcado y lo que espera a otras áreas se le dice', async () => {
        const t = await enEjecucion(); // hoy es el día 2 de 3
        await ver(t);
        const antes = await bloqueDe(t, 'operador', op1());
        expect(antes?.jornada).toEqual({ numero: 2, total: 3, fecha: DIAS[1] });
        expect(antes?.tareas.map((x) => [x.clave, x.estado])).toEqual([
          ['checklist', 'pendiente'],
          ['company_man', 'pendiente'],
          ['reporte_salida', 'pendiente'],
          ['job_log', 'pendiente'],
          ['herramientas', 'pendiente'],
          ['esperando_otras_areas', 'bloqueada'],
          ['jornada_atrasada', 'bloqueada'], // el día 1 ya pasó sin cerrarse
        ]);
        expect(tarea(antes, 'esperando_otras_areas')?.detalle).toContain('PTW del día aprobado');

        await abrirDia(t, DIAS[1]);
        const abierta = await bloqueDe(t, 'operador', op1());
        expect(abierta?.tareas.map((x) => [x.clave, x.estado])).toEqual([
          ['checklist', 'hecha'],
          ['company_man', 'hecha'],
          ['reporte_salida', 'hecha'],
          ['job_log', 'pendiente'],
          ['herramientas', 'pendiente'],
          ['jornada_atrasada', 'bloqueada'],
        ]);
        expect(abierta?.pendientes).toBe(3); // job log, herramientas y la jornada atrasada
        // el otro operador es de otra unidad: ve lo suyo, no lo de su compañero
        const otro = await bloqueDe(t, 'operador', op2());
        expect(otro?.tareas.map((x) => x.clave)).toContain('reporte_salida');
        // quien no está en el servicio no tiene bloque de este ticket
        expect(
          await bloqueDe(t, 'operador', como('operador', uuidv7(), 'Otro', [P.PUMPING_OPERAR])),
        ).toBeUndefined();
      });

      it('el Supervisor ve la aceptación del Company Man y cuándo se puede cerrar la jornada', async () => {
        const t = await enEjecucion();
        await ver(t);
        const antes = await bloqueDe(t, 'supervisor', sup());
        expect(tarea(antes, 'aceptar_company_man')).toMatchObject({ estado: 'pendiente' });
        expect(tarea(antes, 'cerrar_jornada')?.detalle).toContain('todavía no está abierta');

        await abrirDia(t, DIAS[1]);
        const abierta = await bloqueDe(t, 'supervisor', sup());
        expect(tarea(abierta, 'aceptar_company_man')).toMatchObject({ estado: 'hecha' });
        expect(tarea(abierta, 'cerrar_jornada')?.detalle).toContain('Se habilita cuando se cumpla');

        await cumplirCierre(t, DIAS[1]);
        expect(tarea(await bloqueDe(t, 'supervisor', sup()), 'cerrar_jornada')?.detalle).toBe(
          'Lista para cerrar',
        );
        await cerrar(t, DIAS[1]).expect(201);
        expect(tarea(await bloqueDe(t, 'supervisor', sup()), 'cerrar_jornada')).toMatchObject({
          estado: 'hecha',
        });
      });

      it('las jornadas de días pasados sin cerrar aparecen como tarea bloqueada, para el Operador y el Supervisor', async () => {
        const t = await enEjecucion();
        await ver(t);
        hoy = DIAS[2]; // el día 3: los días 1 y 2 ya pasaron sin cerrarse
        for (const [rol, h] of [
          ['operador', op1()],
          ['supervisor', sup()],
        ] as const) {
          const b = await bloqueDe(t, rol, h);
          const atrasadas = b?.tareas.filter((x) => x.clave === 'jornada_atrasada') ?? [];
          expect(atrasadas.map((x) => x.titulo)).toEqual([
            'Jornada del 05/11 sin cerrar',
            'Jornada del 06/11 sin cerrar',
          ]);
          expect(atrasadas.every((x) => x.estado === 'bloqueada')).toBe(true);
          expect(atrasadas[0].detalle).toContain('Falta:');
        }
      });

      it('el Jefe de Base ve los servicios que van adelantados; sin permiso de Pumping no se ve nada', async () => {
        hoy = DIAS[0]; // el plan al primer día es 33,3 %
        const t = await enEjecucion();
        const um = (
          await admin.query('SELECT id FROM catalogos.unidad_medida ORDER BY nombre LIMIT 1')
        ).rows[0].id;
        const linea = uuidv7();
        await admin.query(
          "INSERT INTO pumping.ticket_linea (id, ticket_id, orden, codigo, descripcion, unidad_medida_id, cantidad, tipo_linea) VALUES ($1, $2, 1, $3, 'Herramienta de prueba', $4, 3, 'herramienta')",
          [linea, t.id, `TH-${n}`, um],
        );
        for (let i = 0; i < 2; i++)
          await admin.query(
            "INSERT INTO pumping.reporte_item_dia (id, linea_id, fecha, estado, cantidad, created_by) VALUES ($1, $2, $3, 'operacion', 1, $4)",
            [uuidv7(), linea, DIAS[i], JEFE],
          );
        await ver(t);
        const jefe = como('jefe_base', JEFE, 'Jaime Jefe de Base', [
          P.PUMPING_JORNADA_CAMBIAR_DURACION,
          P.PUMPING_VER,
        ]);
        const r = await http().get(url).set(jefe).expect(200);
        const bloque = (r.body.bloques as Bloque[]).find((b) => b.rol === 'jefe_base');
        const mia = bloque?.tareas.find(
          (x) => x.clave === 'avance_adelantado' && x.titulo.includes('adelantado'),
        );
        expect(mia).toBeDefined();
        const suya = bloque?.tareas.find(
          (x) => (x as Tarea & { ticketId: string }).ticketId === t.id,
        );
        expect(suya).toMatchObject({ clave: 'avance_adelantado', estado: 'pendiente' });
        expect(suya?.detalle).toContain('66.7 % de lo cotizado usado frente a 33.3 % planificado');
        // el Operador no tiene el bloque de Jefe de Base
        const deOperador = await http().get(url).set(op1()).expect(200);
        expect((deOperador.body.bloques as Bloque[]).some((b) => b.rol === 'jefe_base')).toBe(
          false,
        );
        expect(
          (
            await http()
              .get(url)
              .set(como('nadie', uuidv7(), 'Nadie', []))
          ).status,
        ).toBe(403);
      });
    });

    describe('aviso «jornada sin cerrar»: una sola vez por ticket y día, al equipo del ticket', () => {
      const avisos = async (ticketId: string) =>
        (
          await admin.query(
            "SELECT datos->'data' AS d FROM msg_operaciones.outbox WHERE tipo = 'operaciones.pumping.jornada_sin_cerrar' AND datos->'data'->>'ticketId' = $1 ORDER BY id",
            [ticketId],
          )
        ).rows.map((x) => x.d);
      const revisar = (dia: string, t: { id: string }) =>
        app.get(JornadasAvisosService).emitir(dia, [t.id]);

      it('avisa el día que pasó sin cerrarse, no lo repite y al día siguiente avisa el nuevo', async () => {
        const t = await enEjecucion();
        // el día 1 todavía es hoy: nada que avisar
        expect(await revisar(DIAS[0], t)).toEqual({ avisados: 0 });
        // pasó el día 1 sin cerrarse
        expect(await revisar(DIAS[1], t)).toEqual({ avisados: 1 });
        expect(await revisar(DIAS[1], t)).toEqual({ avisados: 0 }); // una sola vez
        const [a] = await avisos(t.id);
        expect(a).toMatchObject({
          ticketId: t.id,
          pedidoId: t.pedidoId,
          fecha: DIAS[0],
          dia: '05/11/2026',
          numero: 1,
        });
        expect(a.faltan).toContain('Checklist de seguridad del día');
        // el equipo del ticket: el supervisor y los dos operadores (no los conductores)
        expect(a.asignados).toEqual(
          expect.arrayContaining([
            { usuarioId: SUPERVISORA.id, rolCodigo: 'supervisor' },
            { usuarioId: OP1.id, rolCodigo: 'operador' },
            { usuarioId: OP2.id, rolCodigo: 'operador' },
          ]),
        );
        expect(a.asignados.every((x: { rolCodigo: string }) => x.rolCodigo !== 'conductor')).toBe(
          true,
        );
        // al día siguiente pasa el día 2: solo ese es nuevo
        expect(await revisar(DIAS[2], t)).toEqual({ avisados: 1 });
        expect((await avisos(t.id)).map((x) => x.fecha)).toEqual([DIAS[0], DIAS[1]]);
      });

      it('no avisa un día sin operación ni un ticket que todavía no está en la ejecución', async () => {
        const t = await enEjecucion();
        await ver(t);
        await sinOp(t, DIAS[0], {
          motivoId: await motivo(),
          detalle: 'Lluvia en el primer día',
        }).expect(201);
        expect(await revisar(DIAS[1], t)).toEqual({ avisados: 0 });
        const enTraslado = await ticketEnTraslado();
        expect(await revisar(DIAS[2], enTraslado)).toEqual({ avisados: 0 });
        expect(await avisos(enTraslado.id)).toEqual([]);
      });
    });

    describe('duración del servicio: el Jefe de Base acorta o amplía', () => {
      const jefeDuracion = () =>
        como('jefe_base', JEFE, 'Jaime Jefe de Base', [
          P.PUMPING_JORNADA_CAMBIAR_DURACION,
          P.PUMPING_VER,
        ]);
      const cambiar = (t: { url: string }, cuerpo: object, h = jefeDuracion()) =>
        http().post(`${t.url}/duracion`).set(h).send(cuerpo);
      // las pruebas comparten personal: los otros servicios abiertos de las mismas personas se cierran para que no se crucen con éste
      const sinPersonal = (t: { id: string }) =>
        admin.query(
          `UPDATE pumping.ticket SET paso_codigo = 'cierre'
            WHERE id <> $1 AND id IN (SELECT ticket_id FROM pumping.ticket_persona
                                       WHERE usuario_id IN (SELECT usuario_id FROM pumping.ticket_persona WHERE ticket_id = $1))`,
          [t.id],
        );
      const finDe = async (id: string) =>
        (
          await admin.query(
            'SELECT fecha_fin_servicio::text AS f FROM pumping.ticket WHERE id = $1',
            [id],
          )
        ).rows[0].f as string;
      const jornadasDe = async (id: string) =>
        (
          await admin.query(
            'SELECT fecha::text AS fecha, estado FROM pumping.ticket_jornada WHERE ticket_id = $1 ORDER BY fecha',
            [id],
          )
        ).rows as Array<{ fecha: string; estado: string }>;
      const bitacora = async (id: string) =>
        (
          await admin.query(
            'SELECT accion, fecha_fin_anterior::text AS anterior, fecha_fin_nueva::text AS nueva, motivo FROM pumping.ticket_duracion_cambio WHERE ticket_id = $1 ORDER BY id',
            [id],
          )
        ).rows as Array<{ accion: string; anterior: string; nueva: string; motivo: string }>;
      const salidas = async (id: string, tipo: string) =>
        (
          await admin.query(
            "SELECT datos->'data' AS d FROM msg_operaciones.outbox WHERE tipo = $1 AND datos->'data'->>'ticketId' = $2 ORDER BY id",
            [tipo, id],
          )
        ).rows.map((r) => r.d);

      it('amplía: crea las jornadas nuevas, anota la bitácora y avisa a Comercial y a QHSE', async () => {
        const t = await enEjecucion();
        await sinPersonal(t);
        await ver(t);
        const r = await cambiar(t, {
          accion: 'ampliar',
          fechaFin: '2026-11-09',
          motivo: 'El pozo se alarga',
        });
        expect(r.status).toBe(201);
        expect(r.body.jornadas).toHaveLength(5);
        expect(await finDe(t.id)).toBe('2026-11-09');
        expect(await bitacora(t.id)).toEqual([
          {
            accion: 'ampliar',
            anterior: DIAS[2],
            nueva: '2026-11-09',
            motivo: 'El pozo se alarga',
          },
        ]);
        const [e] = await salidas(t.id, 'operaciones.pumping.duracion_servicio_cambiada');
        expect(e).toMatchObject({
          pedidoId: t.pedidoId,
          accion: 'ampliar',
          fechaFinAnterior: DIAS[2],
          fechaFinNueva: '2026-11-09',
        });
        const dias = await salidas(t.id, 'operaciones.pumping.dias_de_servicio_actualizados');
        expect(dias.at(-1).dias).toEqual([...DIAS, '2026-11-08', '2026-11-09']);
      });

      it('no amplía si se cruza con otro servicio abierto del mismo personal', async () => {
        const t = await enEjecucion();
        await enEjecucion('2026-11-08', '2026-11-10'); // otro servicio con el mismo personal
        const r = await cambiar(t, {
          accion: 'ampliar',
          fechaFin: '2026-11-09',
          motivo: 'Más días',
        });
        expect(r.status).toBe(409);
        expect(r.body.detail).toContain('se cruza con otro servicio');
        expect(await finDe(t.id)).toBe(DIAS[2]);
        expect(await bitacora(t.id)).toEqual([]);
      });

      it('acorta: las jornadas sobrantes pasan a «no aplica», pero no antes de un día con trabajo registrado', async () => {
        const t = await enEjecucion();
        await ver(t);
        await sinOp(t, DIAS[1], { motivoId: await motivo(), detalle: 'Lluvia todo el día' }).expect(
          201,
        );
        const bloqueado = await cambiar(t, {
          accion: 'acortar',
          fechaFin: DIAS[0],
          motivo: 'Terminó antes',
        });
        expect(bloqueado.status).toBe(409);
        expect(bloqueado.body.detail).toContain('trabajo registrado');
        expect(await finDe(t.id)).toBe(DIAS[2]);

        await cambiar(t, { accion: 'acortar', fechaFin: DIAS[1], motivo: 'Terminó antes' }).expect(
          201,
        );
        expect((await jornadasDe(t.id)).map((j) => [j.fecha, j.estado])).toEqual([
          [DIAS[0], 'pendiente'],
          [DIAS[1], 'sin_operacion'],
          [DIAS[2], 'no_aplica'],
        ]);
        const dias = await salidas(t.id, 'operaciones.pumping.dias_de_servicio_actualizados');
        expect(dias.at(-1).dias).toEqual([DIAS[0]]);
      });

      it('valida fechas y motivo, solo en la Ejecución operativa y solo con el permiso', async () => {
        const t = await enEjecucion();
        const base = { accion: 'ampliar', fechaFin: '2026-11-09', motivo: 'Más días' };
        expect((await cambiar(t, { ...base, fechaFin: DIAS[2] })).status).toBe(409);
        expect(
          (await cambiar(t, { ...base, accion: 'acortar', fechaFin: '2026-11-08' })).status,
        ).toBe(409);
        expect(
          (await cambiar(t, { ...base, accion: 'acortar', fechaFin: '2026-11-04' })).status,
        ).toBe(400);
        expect((await cambiar(t, { ...base, fechaFin: '09/11/2026' })).status).toBe(400);
        expect((await cambiar(t, { ...base, motivo: 'a' })).status).toBe(400);
        expect((await cambiar(t, base, sup())).status).toBe(403);
        expect((await cambiar(t, base, op1())).status).toBe(403);
        expect(await bitacora(t.id)).toEqual([]);

        await admin.query('UPDATE pumping.ticket SET paso_codigo = $2 WHERE id = $1', [
          t.id,
          'control_retorno',
        ]);
        const fuera = await cambiar(t, base);
        expect(fuera.status).toBe(409);
        expect(fuera.body.detail).toContain('Ejecución operativa');
        expect(await finDe(t.id)).toBe(DIAS[2]);
      });

      it('si Comercial no pudo aplicarlo, el ticket vuelve a la fecha anterior y queda en la bitácora', async () => {
        const t = await enEjecucion();
        await sinPersonal(t);
        await cambiar(t, { accion: 'ampliar', fechaFin: '2026-11-09', motivo: 'Más días' }).expect(
          201,
        );
        const rechazo = () => {
          const id = uuidv7();
          eventos.push(id);
          return {
            id,
            type: 'comercial.duracion_servicio.rechazada',
            version: 1,
            occurredAt: new Date().toISOString(),
            source: 'comercial',
            subject: { type: 'pedido', id: t.pedidoId },
            actor: { userId: JEFE, role: 'jefe_base' },
            data: {
              ticketId: t.id,
              pedidoId: t.pedidoId,
              fechaFinAnterior: DIAS[2],
              fechaFinNueva: '2026-11-09',
              motivo: 'El pedido ya salió al cliente',
            },
          } as EventEnvelope;
        };
        const e = rechazo();
        const resultado = app.get(DuracionResultadoConsumer);
        await resultado.consumir(e);
        await resultado.consumir(e); // mismo evento: lo ignora el inbox
        expect(await finDe(t.id)).toBe(DIAS[2]);
        expect((await jornadasDe(t.id)).map((j) => [j.fecha, j.estado]).slice(3)).toEqual([
          ['2026-11-08', 'no_aplica'],
          ['2026-11-09', 'no_aplica'],
        ]);
        const b = await bitacora(t.id);
        expect(b.map((x) => x.accion)).toEqual(['ampliar', 'revertir']);
        expect(b[1].motivo).toContain('El pedido ya salió al cliente');
        // otro rechazo (otro evento) cuando el ticket ya no tiene esa fecha: no toca nada
        await resultado.consumir(rechazo());
        expect(await bitacora(t.id)).toHaveLength(2);
      });
    });

    describe('avance del servicio: cotizado frente a usado y aviso de que va adelantado', () => {
      /** Una línea de herramienta cotizada (`cotizado`) con `usados` días reportados desde el primer día del servicio. */
      const conAvance = async (cotizado: number, usados: number) => {
        const t = await enEjecucion();
        const linea = uuidv7();
        const um = (
          await admin.query('SELECT id FROM catalogos.unidad_medida ORDER BY nombre LIMIT 1')
        ).rows[0].id;
        await admin.query(
          "INSERT INTO pumping.ticket_linea (id, ticket_id, orden, codigo, descripcion, unidad_medida_id, cantidad, tipo_linea) VALUES ($1, $2, 1, $3, 'Herramienta de prueba', $4, $5, 'herramienta')",
          [linea, t.id, `AV-${n}`, um, cotizado],
        );
        for (let i = 0; i < usados; i++)
          await admin.query(
            "INSERT INTO pumping.reporte_item_dia (id, linea_id, fecha, estado, cantidad, created_by) VALUES ($1, $2, $3, 'operacion', 1, $4)",
            [uuidv7(), linea, DIAS[i], JEFE],
          );
        await ver(t); // deja las jornadas creadas
        return t;
      };
      const evaluar = (id: string) =>
        prisma.$transaction((tx) => app.get(AvanceService).evaluarAdelanto(tx, id));
      const avisosDe = async (id: string) =>
        (
          await admin.query(
            "SELECT datos->'data' AS d FROM msg_operaciones.outbox WHERE tipo = 'operaciones.pumping.avance_adelantado' AND datos->'data'->>'ticketId' = $1",
            [id],
          )
        ).rows.map((x) => x.d);

      it('muestra lo cotizado y lo usado por línea y el avance real frente al planificado', async () => {
        const t = await conAvance(3, 2); // hoy es el día 2 de 3: lo planificado es 66,7 %
        const r = await http().get(`${t.url}/avance`).set(op1());
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({
          avanceReal: 66.7,
          avancePlan: 66.7,
          diferencia: 0,
          diaActual: 2,
          diasTotal: 3,
          adelantado: false,
          atrasado: false,
          solicitudesPendientes: [],
        });
        expect(r.body.lineas).toEqual([
          expect.objectContaining({
            codigo: `AV-${n}`,
            cotizado: 3,
            usado: 2,
            porcentaje: 66.7,
            excedido: false,
          }),
        ]);
        expect(
          (
            await http()
              .get(`${t.url}/avance`)
              .set(como('nadie', uuidv7(), 'Nadie', []))
          ).status,
        ).toBe(403);
      });

      it('avisa una sola vez al Jefe de Base cuando el avance va adelantado del plan', async () => {
        hoy = DIAS[0]; // el plan al primer día es 33,3 %; ya se usaron 2 de 3 (66,7 %)
        const t = await conAvance(3, 2);
        const a = (await http().get(`${t.url}/avance`).set(op1())).body;
        expect(a).toMatchObject({ adelantado: true, diferencia: 33.4, diaActual: 1 });

        expect(await evaluar(t.id)).toBe(true);
        expect(await evaluar(t.id)).toBe(false); // ya se avisó
        const avisos = await avisosDe(t.id);
        expect(avisos).toHaveLength(1);
        expect(avisos[0]).toMatchObject({
          ticketId: t.id,
          pedidoId: t.pedidoId,
          avanceReal: 66.7,
          avancePlan: 33.3,
          diaActual: 1,
          diasTotal: 3,
        });
      });

      it('no avisa si va al ritmo del plan ni en el último día, y muestra cuando va atrasado', async () => {
        const alRitmo = await conAvance(3, 2); // hoy: día 2 de 3
        expect(await evaluar(alRitmo.id)).toBe(false);

        hoy = DIAS[2];
        const ultimo = await conAvance(3, 3);
        expect((await http().get(`${ultimo.url}/avance`).set(op1())).body.adelantado).toBe(false);
        expect(await evaluar(ultimo.id)).toBe(false);

        const atrasado = await conAvance(3, 0);
        expect((await http().get(`${atrasado.url}/avance`).set(op1())).body).toMatchObject({
          avanceReal: 0,
          atrasado: true,
          adelantado: false,
        });
        expect(await avisosDe(alRitmo.id)).toEqual([]);
      });
    });

    describe('reporte de unidad por día: salida y llegada de cada jornada', () => {
      const unidad = VEHICULO.unidadId;
      const urlDia = (t: { url: string }, fecha: string) =>
        `${t.url}/reportes-unidad/${unidad}/${fecha}`;
      const items = async (t: { url: string }, fecha: string) =>
        (
          (await http().get(urlDia(t, fecha)).set(supervisora()).expect(200)).body
            .inspecciones as Array<{ itemId: string }>
        )
          .slice(0, 3)
          .map((i) => ({ itemId: i.itemId, resultado: 'conforme' }));
      const cuerpoSalida = async (t: { url: string }, fecha: string) => ({
        fecha: '2000-01-01', // la ruta manda: el día del reporte es el de la ruta
        combustible: 80.5,
        origen: 'Base Coco',
        destino: 'Pozo Beta-9',
        hubodometros: [{ eje: 'A', punto: 'origen', salida: 1000 }],
        llantas: [{ posicion: 'delantera_izquierda', salida: '80 PSI' }],
        inspecciones: await items(t, fecha),
      });
      const cuerpoLlegada = async (t: { url: string }, fecha: string) => ({
        fecha,
        combustible: 20,
        hubodometros: [{ eje: 'A', punto: 'destino', llegada: 1100 }],
        llantas: [{ posicion: 'delantera_izquierda', llegada: '78 PSI' }],
        inspecciones: await items(t, fecha),
        unidadLista: true,
        operacionInterrumpida: false,
      });
      const reportes = async (id: string) =>
        (
          await admin.query(
            'SELECT fecha::text AS fecha, salida_firmada_at IS NOT NULL AS salida, llegada_firmada_at IS NOT NULL AS llegada FROM pumping.reporte_unidad WHERE ticket_id = $1 ORDER BY fecha',
            [id],
          )
        ).rows as Array<{ fecha: string; salida: boolean; llegada: boolean }>;

      it('cada día de la ejecución tiene su propio reporte: salida y llegada se firman por separado', async () => {
        const t = await enEjecucion();
        for (const dia of [DIAS[0], DIAS[1]]) {
          const cuerpo = await cuerpoSalida(t, dia);
          await http()
            .put(`${urlDia(t, dia)}/salida`)
            .set(op1())
            .send(cuerpo)
            .expect(200);
        }
        expect(await reportes(t.id)).toEqual([
          { fecha: DIAS[0], salida: true, llegada: false },
          { fecha: DIAS[1], salida: true, llegada: false },
        ]);

        // la firma de la salida cumple el requisito de apertura de ese día para esa unidad, y solo para ella
        const requisito = async (codigo: string, fecha: string) =>
          (
            await admin.query(
              'SELECT unidad_id, estado FROM pumping.ticket_requisito WHERE ticket_id = $1 AND requisito_codigo = $2 AND fecha = $3 ORDER BY unidad_id',
              [t.id, codigo, fecha],
            )
          ).rows as Array<{ unidad_id: string; estado: string }>;
        const salidas = await requisito('reporte_unidad_salida_dia', DIAS[0]);
        expect(salidas.find((x) => x.unidad_id === unidad)?.estado).toBe('cumplido');
        expect(salidas.find((x) => x.unidad_id !== unidad)?.estado).toBe('pendiente');
        // la llegada del día 1 no toca la del día 2
        const cuerpoDia1 = await cuerpoLlegada(t, DIAS[0]);
        const llegada = await http()
          .put(`${urlDia(t, DIAS[0])}/llegada`)
          .set(op1())
          .send(cuerpoDia1)
          .expect(200);
        expect(llegada.body.llegada.firmadaAt).not.toBeNull();
        expect((await http().get(urlDia(t, DIAS[1])).set(op1()).expect(200)).body).toMatchObject({
          fecha: DIAS[1],
          llegada: { firmadaAt: null },
        });
        expect(await reportes(t.id)).toEqual([
          { fecha: DIAS[0], salida: true, llegada: true },
          { fecha: DIAS[1], salida: true, llegada: false },
        ]);

        // el listado por día muestra el estado de cada unidad ese día
        const lista = (
          await http()
            .get(`${t.url}/reportes-unidad`)
            .query({ fecha: DIAS[1] })
            .set(op1())
            .expect(200)
        ).body as Array<{
          unidadId: string;
          fecha: string;
          salidaFirmada: boolean;
          llegadaFirmada: boolean;
        }>;
        expect(lista.find((u) => u.unidadId === unidad)).toMatchObject({
          fecha: DIAS[1],
          salidaFirmada: true,
          llegadaFirmada: false,
        });
        // el aviso a Mantenimiento lleva el día del reporte
        const avisos = (
          await admin.query(
            "SELECT datos->'data' AS d FROM msg_operaciones.outbox WHERE tipo = 'operaciones.pumping.reporte_unidad_llegada' AND datos->'data'->>'ticketId' = $1",
            [t.id],
          )
        ).rows.map((x) => x.d);
        expect(avisos).toHaveLength(1);
        expect(avisos[0]).toMatchObject({ unidadId: unidad, fecha: DIAS[0] });
      });

      it('no se firma un día futuro ni fuera del servicio, ni con un día mal escrito, ni por quien no es el operador', async () => {
        const t = await enEjecucion(); // hoy es el día 2 de 3
        const cuerpo = await cuerpoSalida(t, DIAS[0]);
        const salida = (dia: string, h = op1()) =>
          http()
            .put(`${urlDia(t, dia)}/salida`)
            .set(h)
            .send(cuerpo);
        expect((await salida(DIAS[2])).status).toBe(409); // el día 3 todavía no llega
        expect((await salida('2026-11-10')).status).toBe(404); // fuera del servicio
        expect((await salida('ayer')).status).toBe(400);
        expect((await salida(DIAS[0], op2())).status).toBe(403); // la unidad es de otro operador
        expect(await reportes(t.id)).toEqual([]);
        // un día que se registró sin operación ya no admite reportes
        await sinOp(t, DIAS[1], { motivoId: await motivo(), detalle: 'Lluvia todo el día' }).expect(
          201,
        );
        expect((await salida(DIAS[1])).status).toBe(409);
      });
    });
  });
});
