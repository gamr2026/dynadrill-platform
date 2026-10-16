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
import { MessagingModule, type EventEnvelope } from '@dyn/messaging';
import { uuidv7 } from '@dyn/utils';
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
};

run('Pumping: tickets de los pedidos abiertos (base de datos real)', () => {
  jest.setTimeout(90000);
  let app: INestApplication;
  let prisma: PrismaService;
  let consumer: PedidosAbiertosConsumer;
  let externos: RequisitosExternosConsumer;
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
    await app.init();
    prisma = app.get(PrismaService);
    consumer = app.get(PedidosAbiertosConsumer);
    externos = app.get(RequisitosExternosConsumer);
  });

  afterAll(async () => {
    if (pedidos.length)
      await admin.query('DELETE FROM pumping.ticket WHERE pedido_id = ANY($1::uuid[])', [pedidos]);
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
    // lo que el proceso exige: del ticket 3 (checklist de ingreso, gerenciamiento de viaje de salida y de retorno), 3 por unidad, 2 por operador
    const req = await requisitosDe(t.id);
    expect(req).toHaveLength(3 + 3 * 2 + 2 * 2);
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
});
