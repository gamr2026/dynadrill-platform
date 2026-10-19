/**
 * Integración real de QHSE (tramo Q1): PostgreSQL (PgBouncer, app_qhse). El consumidor de Pumping se prueba llamando a `consumir`
 * con un evento como el que publica `operaciones` (sin RabbitMQ). Limpia lo que crea.
 *   RUN_INTEGRATION=1 npx nx test qhse-seguridad
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
import { ArticulosEpiConsumer } from './consumers/articulos-epi.consumer';
import { PumpingEventosConsumer } from './consumers/pumping-eventos.consumer';
import { PrismaService } from './prisma/prisma.service';
import { QhseModule } from './qhse.module';
import { quitarMaestros, sembrarMaestros, type MaestrosDePrueba } from './testing/maestros';

const run = process.env['RUN_INTEGRATION'] ? describe : describe.skip;

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const APP_DB =
  process.env['TEST_QHSE_DATABASE_URL'] ??
  'postgresql://app_qhse:dev_app_qhse@localhost:6432/dynadrill?pgbouncer=true';
const MIGRATOR_DB =
  process.env['TEST_MIGRATOR_DATABASE_URL'] ??
  'postgresql://dyn_migrator:dev_dyn_migrator@localhost:5433/dynadrill';

const n = Date.now();
const P = Permission;
const TODOS = [P.EPI_VER, P.EPI_CREAR, P.EPI_APROBAR, P.EPI_DESPACHAR];

/** Cuentas reales de prueba: la entrega guarda quién la recibió y quién actuó (FK a identidad). */
const TECNICO = { id: uuidv7(), nombre: 'Tania Técnica HSE' };
const GERENTE = { id: uuidv7(), nombre: 'Gerardo Gerente HSE' };
const JEFE = { id: uuidv7(), nombre: 'Jaime Jefe de Base' };
const SUPERVISOR = { id: uuidv7(), nombre: 'Sara Supervisora' };
const OP1 = {
  id: uuidv7(),
  nombre: 'Oscar Operador',
  cedula: `17${String(n).slice(-8)}`,
  cargo: 'Operador de bombeo',
};
const OP2 = { id: uuidv7(), nombre: 'Olga Operadora' };
const OP_INACTIVO = { id: uuidv7(), nombre: 'Ismael Inactivo' };
const BODEGA = { id: uuidv7(), nombre: `Base de prueba ${n}` };
const MAESTROS: MaestrosDePrueba = {
  bodegas: [BODEGA],
  usuarios: [
    { ...TECNICO, rol: 'tecnico_hse' },
    { ...GERENTE, rol: 'gerente_hse' },
    { ...JEFE, rol: 'jefe_base' },
    { ...SUPERVISOR, rol: 'supervisor' },
    { ...OP1, rol: 'operador' },
    { ...OP2, rol: 'operador' },
    { ...OP_INACTIVO, rol: 'operador', activo: false },
  ],
};

run('QHSE Q1: entrega de EPI y eventos de Pumping (base de datos real)', () => {
  jest.setTimeout(90000);
  let app: INestApplication;
  let prisma: PrismaService;
  let consumer: PumpingEventosConsumer;
  const admin = new Pool({ connectionString: MIGRATOR_DB, max: 2 });
  const http = () => request(app.getHttpServer());
  const signer = new JwtService({
    privateKey,
    signOptions: { algorithm: 'RS256', issuer: 'dynadrill-plataforma', expiresIn: 600 },
  });
  const token = (roleCode: string, name: string, permissions: string[], sub: string) => ({
    Authorization: `Bearer ${signer.sign({ sub, email: `${roleCode}@test.local`, name, roleId: 'r', roleCode, permissions })}`,
  });
  const tecnico = () => token('tecnico_hse', TECNICO.nombre, TODOS, TECNICO.id);
  const gerente = () => token('gerente_hse', GERENTE.nombre, TODOS, GERENTE.id);
  /** Un supervisor no entra a QHSE: su cuenta no trae ningún permiso de EPI. */
  const supervisor = () =>
    token('supervisor', SUPERVISOR.nombre, [P.PUMPING_OPERAR], SUPERVISOR.id);
  /** Un técnico que solo puede ver. */
  const soloVer = () => token('tecnico_hse', TECNICO.nombre, [P.EPI_VER], TECNICO.id);

  const tickets: string[] = [];
  const pedidos: string[] = [];
  const eventos: string[] = [];
  let numeroTicket = 700_000 + (n % 100_000) * 10;

  const eventoAsignacion = (
    ticketId: string,
    operadores: string[],
    extra: Record<string, unknown> = {},
  ): EventEnvelope => {
    const id = uuidv7();
    eventos.push(id);
    const pedidoId = (extra['pedidoId'] as string | undefined) ?? uuidv7();
    if (!tickets.includes(ticketId)) tickets.push(ticketId);
    if (!pedidos.includes(pedidoId)) pedidos.push(pedidoId);
    return {
      id,
      type: 'operaciones.pumping.asignacion_realizada',
      version: 1,
      occurredAt: '2026-11-02T10:00:00.000Z',
      source: 'operaciones',
      subject: { type: 'pumping_ticket', id: ticketId },
      actor: { userId: JEFE.id, role: 'jefe_base' },
      data: {
        ticketId,
        ticketNumero: numeroTicket++,
        pedidoId,
        pedidoCodigo: `PED-QH${n}`,
        cliente: 'Cliente de prueba',
        operadoresUnidades: operadores.map((o) => ({ usuarioId: o, vehiculoId: uuidv7() })),
        asignados: [
          { usuarioId: SUPERVISOR.id, rolCodigo: 'supervisor' },
          ...operadores.map((o) => ({ usuarioId: o, rolCodigo: 'operador' })),
        ],
        ...extra,
      },
    } as EventEnvelope;
  };

  const entregasDe = (ticketId: string) =>
    prisma.epiEntrega.findMany({ where: { ticketId }, orderBy: { createdAt: 'asc' } });
  /** QHSE registra a mano la entrega de un operador de un ticket (la asignación ya no la abre sola: la pide Pumping o la registra QHSE). */
  const solicitarAMano = (ticketId: string, trabajadorId: string) =>
    http().post('/api/qhse/epi').set(tecnico()).send({ trabajadorId, ticketId }).expect(201);
  const salida = async (entregaId: string) =>
    (
      await admin.query(
        "SELECT tipo, datos FROM msg_qhse.outbox WHERE datos->'data'->>'entregaId' = $1 ORDER BY ocurrido_at, id",
        [entregaId],
      )
    ).rows as Array<{ tipo: string; datos: { source: string; data: Record<string, unknown> } }>;
  const salidaDeTicket = async (ticketId: string, tipo: string) =>
    (
      await admin.query(
        "SELECT tipo, datos FROM msg_qhse.outbox WHERE tipo = $2 AND datos->'data'->>'ticketId' = $1 ORDER BY ocurrido_at, id",
        [ticketId, tipo],
      )
    ).rows as Array<{ tipo: string; datos: { source: string; data: Record<string, unknown> } }>;
  type Elemento = { id: string; codigo: string; tipoTalla: string | null };
  let elementos: Elemento[] = [];
  let tallas: Array<{ id: string; tipo: string; codigo: string }> = [];
  /** Código con el que la prueba crea cada elemento (los reales son códigos de AS2: EPP-0004...). */
  const codigoDe = (clave: string) => `IT${n}-${clave}`;
  const elemento = (clave: string) =>
    elementos.find((e) => e.codigo === codigoDe(clave)) as Elemento;
  let articulosEpi: ArticulosEpiConsumer;
  const eventoArticulo = (
    articuloId: string,
    clave: string,
    extra: Record<string, unknown> = {},
    occurredAt = new Date().toISOString(),
  ): EventEnvelope => {
    const id = uuidv7();
    eventos.push(id);
    return {
      id,
      type: 'operaciones.inventario.articulo_epi_actualizado',
      version: 1,
      occurredAt,
      source: 'operaciones',
      subject: { type: 'inventario_articulo', id: articuloId },
      actor: { userId: JEFE.id, role: 'jefe_base' },
      data: {
        articuloId,
        codigo: codigoDe(clave),
        nombre: `Elemento de prueba ${clave}`,
        tipoTalla: null,
        entregaPersonal: true,
        activo: true,
        ...extra,
      },
    } as EventEnvelope;
  };
  const talla = (tipo: string, codigo: string) =>
    tallas.find((t) => t.tipo === tipo && t.codigo === codigo) as (typeof tallas)[number];
  /** Un renglón válido: con talla de guante si se pide, o un casco (que no lleva talla). */
  const renglon = (conTalla = false) =>
    conTalla
      ? {
          elementoId: elemento('guantes_nitrilo').id,
          cantidad: 2,
          tallaId: talla('guante', '9').id,
          recibioCapacitacion: true,
        }
      : { elementoId: elemento('casco').id, cantidad: 2, recibioCapacitacion: true };

  beforeAll(async () => {
    await sembrarMaestros(admin, MAESTROS);
    Object.assign(process.env, {
      SERVICE_NAME: 'qhse-test',
      PORT: '3194',
      LOG_LEVEL: 'silent',
      DATABASE_URL: APP_DB,
      RABBITMQ_URL: 'amqp://x:x@localhost:5672',
      JWT_PUBLIC_KEY: publicKey,
    });
    const envSchema = defineEnv(baseEnvSchema, databaseEnvSchema, jwtVerifyEnvSchema);
    @Module({
      imports: [
        AppConfigModule.forRoot(envSchema),
        CommonModule.forRoot({ serviceName: 'qhse-test' }),
        MessagingModule.forRoot({
          container: 'qhse',
          schema: 'msg_qhse',
          rabbitUrl: 'amqp://x:x@localhost:5672',
          databaseUrl: APP_DB,
          relay: { enabled: false },
        }),
        QhseModule,
      ],
    })
    class TestAppModule {}
    const mod = await Test.createTestingModule({ imports: [TestAppModule] }).compile();
    app = mod.createNestApplication();
    configureApp(app, { corsOrigins: ['http://localhost:4200'] });
    // sin RabbitMQ: el consumidor se invoca a mano; evitamos que intente suscribirse al arrancar
    jest
      .spyOn(PumpingEventosConsumer.prototype, 'onApplicationBootstrap')
      .mockResolvedValue(undefined);
    jest
      .spyOn(ArticulosEpiConsumer.prototype, 'onApplicationBootstrap')
      .mockResolvedValue(undefined);
    await app.init();
    prisma = app.get(PrismaService);
    consumer = app.get(PumpingEventosConsumer);
    articulosEpi = app.get(ArticulosEpiConsumer);
    for (const [clave, tipoTalla] of [
      ['casco', null],
      ['guantes_nitrilo', 'guante'],
      ['overol', 'ropa'],
    ] as const) {
      await articulosEpi.consumir(eventoArticulo(uuidv7(), clave, { tipoTalla }));
    }
    elementos = await prisma.epiElemento.findMany({
      where: { codigo: { startsWith: `IT${n}-` } },
      select: { id: true, codigo: true, tipoTalla: true },
    });
    tallas = await prisma.epiTalla.findMany({ select: { id: true, tipo: true, codigo: true } });
  });

  afterAll(async () => {
    if (tickets.length) {
      // las entregas (y sus renglones e historial) caen en cascada; `app_qhse` no borra cabeceras, por eso va dyn_migrator
      // los PTW abiertos al asignar (y su historia) caen antes que el ticket al que pertenecen
      await admin.query('DELETE FROM qhse.ptw WHERE ticket_id = ANY($1::uuid[])', [tickets]);
      await admin.query('DELETE FROM qhse.epi_entrega WHERE ticket_id = ANY($1::uuid[])', [
        tickets,
      ]);
      await admin.query('DELETE FROM qhse.ticket_ref WHERE ticket_id = ANY($1::uuid[])', [tickets]);
    }
    await admin.query('DELETE FROM qhse.epi_entrega WHERE trabajador_id = ANY($1::uuid[])', [
      [OP1.id, OP2.id, OP_INACTIVO.id],
    ]);
    await admin.query('DELETE FROM qhse.epi_elemento WHERE codigo LIKE $1', [`IT${n}-%`]);
    if (eventos.length) {
      await admin.query('DELETE FROM msg_qhse.inbox WHERE id = ANY($1::uuid[])', [eventos]);
    }
    await admin.query(
      "DELETE FROM msg_qhse.outbox WHERE datos->'data'->>'ticketId' = ANY($1::text[]) OR datos->'data'->>'usuarioId' = ANY($2::text[])",
      [tickets, [OP1.id, OP2.id, OP_INACTIVO.id]],
    );
    await quitarMaestros(admin, MAESTROS);
    await admin.end();
    await app.close();
  });

  // ------------------------------------------------------------------------------------------------ consumidor

  it('guarda el ticket y sus operadores asignados (no el supervisor) y ya no abre solicitudes de EPI por su cuenta', async () => {
    const ticketId = uuidv7();
    const e = eventoAsignacion(ticketId, [OP1.id, OP2.id]);
    await consumer.consumir(e);

    const ref = await prisma.ticketRef.findUniqueOrThrow({ where: { ticketId } });
    expect(ref).toMatchObject({ pedidoCodigo: `PED-QH${n}`, ticketNumero: e.data['ticketNumero'] });
    const operadores = await prisma.ticketOperador.findMany({ where: { ticketId } });
    expect(operadores.map((x) => x.usuarioId).sort()).toEqual([OP1.id, OP2.id].sort());
    // el EPI lo pide el equipo de Pumping desde el ticket: la asignación no crea nada ni avisa a QHSE
    expect(await entregasDe(ticketId)).toHaveLength(0);
    expect(await salidaDeTicket(ticketId, 'qhse.epi.solicitudes_abiertas')).toHaveLength(0);
  });

  it('es idempotente y una reasignación reemplaza a los operadores anteriores', async () => {
    const ticketId = uuidv7();
    const e = eventoAsignacion(ticketId, [OP1.id]);
    await consumer.consumir(e);
    await consumer.consumir(e);
    const operadoresDe = async () =>
      (await prisma.ticketOperador.findMany({ where: { ticketId } }))
        .map((x) => x.usuarioId)
        .sort();
    expect(await operadoresDe()).toEqual([OP1.id]);
    await consumer.consumir(eventoAsignacion(ticketId, [OP2.id], { pedidoId: e.data['pedidoId'] }));
    expect(await operadoresDe()).toEqual([OP2.id]);
  });

  it('ignora sin error un evento sin ticket o sin pedido, y no guarda a los operadores que no existen o están inactivos', async () => {
    const sinTicket = eventoAsignacion(uuidv7(), [OP1.id]);
    delete sinTicket.data['ticketId'];
    await expect(consumer.consumir(sinTicket)).resolves.toBeUndefined();

    const ticketId = uuidv7();
    await consumer.consumir(eventoAsignacion(ticketId, [uuidv7(), OP_INACTIVO.id]));
    expect(await prisma.ticketOperador.count({ where: { ticketId } })).toBe(0);
    // el ticket sí quedó referenciado: se conoce aunque nadie tenga operadores válidos
    expect(await prisma.ticketRef.count({ where: { ticketId } })).toBe(1);
  });

  it('al asignar el equipo abre el PTW del primer día de operación (una sola vez, a nombre de quien asignó) y no abre nada sin fecha de inicio', async () => {
    const ticketId = uuidv7();
    const e = eventoAsignacion(ticketId, [OP1.id], { fechaInicioServicio: '2026-11-02' });
    await consumer.consumir(e);
    const ptws = await prisma.ptw.findMany({ where: { ticketId } });
    expect(ptws).toHaveLength(1);
    expect(ptws[0]).toMatchObject({ createdBy: JEFE.id, fase: 'gabinete' });
    expect(ptws[0].diaOperacion.toISOString().slice(0, 10)).toBe('2026-11-02');
    expect(await salidaDeTicket(ticketId, 'qhse.ptw.abierto')).toHaveLength(1);
    // una reasignación del mismo servicio no duplica el PTW del día
    await consumer.consumir(
      eventoAsignacion(ticketId, [OP2.id], {
        pedidoId: e.data['pedidoId'],
        fechaInicioServicio: '2026-11-02',
      }),
    );
    expect(await prisma.ptw.count({ where: { ticketId } })).toBe(1);

    const sinFecha = uuidv7();
    await consumer.consumir(eventoAsignacion(sinFecha, [OP1.id]));
    expect(await prisma.ptw.count({ where: { ticketId: sinFecha } })).toBe(0);
  });

  it('guarda la referencia del ticket cuando Pumping lo crea (ticket_creado) y la actualiza sin duplicarla', async () => {
    const ticketId = uuidv7();
    const pedidoId = uuidv7();
    tickets.push(ticketId);
    pedidos.push(pedidoId);
    const base = {
      version: 1,
      occurredAt: '2026-11-02T10:00:00.000Z',
      source: 'operaciones',
      type: 'operaciones.pumping.ticket_creado',
      subject: { type: 'pumping_ticket', id: ticketId },
    };
    const ev = (ticketNumero: number) => {
      const id = uuidv7();
      eventos.push(id);
      return {
        ...base,
        id,
        data: { ticketId, ticketNumero, pedidoId, pedidoCodigo: `PED-TC${n}` },
      } as EventEnvelope;
    };
    await consumer.consumir(ev(111));
    await consumer.consumir(ev(222));
    const refs = await prisma.ticketRef.findMany({ where: { ticketId } });
    expect(refs).toHaveLength(1);
    expect(refs[0].ticketNumero).toBe(222);
  });

  // ------------------------------------------------------------------------------------------------ solicitud desde el ticket

  describe('solicitud de EPI desde el ticket (equipo de Pumping)', () => {
    /** Una cuenta del equipo de Pumping: solo trae el permiso de solicitar EPI (no entra al resto de QHSE). */
    const operativo = () => token('operador', SUPERVISOR.nombre, [P.EPI_SOLICITAR], SUPERVISOR.id);
    let ticketId: string;

    beforeAll(async () => {
      ticketId = uuidv7();
      await consumer.consumir(eventoAsignacion(ticketId, [OP1.id, OP2.id]));
    });

    it('el equipo ve a los operadores del ticket y los catálogos, pero no la bandeja de QHSE', async () => {
      const r = await http().get(`/api/qhse/epi/ticket/${ticketId}`).set(operativo()).expect(200);
      expect(r.body.map((o: { usuarioId: string }) => o.usuarioId).sort()).toEqual(
        [OP1.id, OP2.id].sort(),
      );
      expect(r.body.every((o: { entrega: unknown }) => o.entrega === null)).toBe(true);
      expect(r.body[0]).toMatchObject({ nombre: expect.any(String) });
      await http().get('/api/qhse/epi/elementos').set(operativo()).expect(200);
      await http().get('/api/qhse/epi/lugares').set(operativo()).expect(200);
      await http().get('/api/qhse/epi').set(operativo()).expect(403);
      // quien no tiene el permiso (un supervisor sin él) no ve nada de esto
      await http().get(`/api/qhse/epi/ticket/${ticketId}`).set(supervisor()).expect(403);
    });

    it('pide el EPI de un operador del ticket con sus elementos: queda solicitado y avisa a QHSE', async () => {
      const r = await http()
        .post(`/api/qhse/epi/ticket/${ticketId}`)
        .set(operativo())
        .send({
          trabajadorId: OP1.id,
          lugarBodegaId: BODEGA.id,
          renglones: [renglon(false), renglon(true)],
        })
        .expect(201);
      expect(r.body).toMatchObject({
        estado: 'solicitado',
        trabajador: { id: OP1.id },
        ticket: { id: ticketId },
      });
      expect(r.body.renglones).toHaveLength(2);

      const avisos = await salidaDeTicket(ticketId, 'qhse.epi.solicitudes_abiertas');
      expect(avisos).toHaveLength(1);
      expect(avisos[0].datos.data).toMatchObject({
        ticketId,
        pedidoCodigo: `PED-QH${n}`,
        cantidad: 1,
        trabajadores: OP1.nombre,
      });
      expect((await salida(r.body.id)).map((p) => p.tipo)).toEqual(['qhse.epi.solicitada']);

      // el equipo ve el estado de cada uno
      const estado = await http()
        .get(`/api/qhse/epi/ticket/${ticketId}`)
        .set(operativo())
        .expect(200);
      const por = (id: string) =>
        estado.body.find((o: { usuarioId: string }) => o.usuarioId === id);
      expect(por(OP1.id).entrega).toMatchObject({ estado: 'solicitado', id: r.body.id });
      expect(por(OP2.id).entrega).toBeNull();
    });

    it('no deja pedirlo dos veces, ni para quien no es operador del ticket, ni sin elementos, ni sin el permiso', async () => {
      const pedir = (cuerpo: Record<string, unknown>, quien = operativo()) =>
        http().post(`/api/qhse/epi/ticket/${ticketId}`).set(quien).send(cuerpo);
      const dos = await pedir({ trabajadorId: OP1.id, renglones: [renglon(false)] }).expect(409);
      expect(dos.body.detail).toMatch(/ya tiene la entrega/);
      const ajeno = await pedir({ trabajadorId: JEFE.id, renglones: [renglon(false)] }).expect(400);
      expect(ajeno.body.detail).toMatch(/no es un operador asignado/);
      const vacia = await pedir({ trabajadorId: OP2.id, renglones: [] }).expect(400);
      expect(vacia.body.detail).toMatch(/al menos un elemento/);
      await pedir({ trabajadorId: OP2.id, renglones: [renglon(false)] }, soloVer()).expect(403);
      // un ticket que QHSE no conoce
      await http()
        .post(`/api/qhse/epi/ticket/${uuidv7()}`)
        .set(operativo())
        .send({ trabajadorId: OP2.id, renglones: [renglon(false)] })
        .expect(404);
    });
  });

  // ------------------------------------------------------------------------------------------------ ciclo de vida

  describe('ciclo de vida de una entrega', () => {
    let ticketId: string;
    let entregaId: string;

    beforeAll(async () => {
      ticketId = uuidv7();
      await consumer.consumir(eventoAsignacion(ticketId, [OP1.id]));
      // QHSE registra la entrega a mano (el equipo de Pumping la pide por su endpoint; ver el bloque anterior)
      entregaId = (
        await http()
          .post('/api/qhse/epi')
          .set(tecnico())
          .send({ trabajadorId: OP1.id, ticketId })
          .expect(201)
      ).body.id;
    });

    it('la bandeja y el detalle traen al trabajador con su cédula y cargo, que salen de su perfil (JOIN, no capturados)', async () => {
      const lista = await http()
        .get('/api/qhse/epi')
        .query({ ticketId })
        .set(tecnico())
        .expect(200);
      expect(lista.body).toHaveLength(1);
      expect(lista.body[0]).toMatchObject({
        id: entregaId,
        estado: 'solicitado',
        trabajador: { id: OP1.id, nombre: OP1.nombre, cedula: OP1.cedula, cargo: OP1.cargo },
        ticket: { id: ticketId, pedidoCodigo: `PED-QH${n}` },
        renglones: 0,
      });
      expect(lista.body[0].codigo).toMatch(/^EPI-\d{6}$/);

      const det = await http().get(`/api/qhse/epi/${entregaId}`).set(gerente()).expect(200);
      expect(det.body.trabajador.cedula).toBe(OP1.cedula);
      expect(det.body.historial).toHaveLength(1);
    });

    it('filtra por estado, por trabajador y por búsqueda', async () => {
      const porEstado = await http()
        .get('/api/qhse/epi')
        .query({ estado: 'despachado', trabajadorId: OP1.id })
        .set(tecnico())
        .expect(200);
      expect(porEstado.body.every((x: { estado: string }) => x.estado === 'despachado')).toBe(true);
      const porCedula = await http()
        .get('/api/qhse/epi')
        .query({ q: OP1.cedula })
        .set(tecnico())
        .expect(200);
      expect(porCedula.body.some((x: { id: string }) => x.id === entregaId)).toBe(true);
      await http().get('/api/qhse/epi').query({ estado: 'inventado' }).set(tecnico()).expect(400);
    });

    it('no se puede despachar lo que no está aprobado ni sin renglones, lugar y declaración del trabajador', async () => {
      await http().post(`/api/qhse/epi/${entregaId}/despachar`).set(tecnico()).expect(409);
      await http().post(`/api/qhse/epi/${entregaId}/aprobar`).set(tecnico()).expect(201);
      await http().post(`/api/qhse/epi/${entregaId}/aprobar`).set(tecnico()).expect(409);

      const sinRenglones = await http()
        .post(`/api/qhse/epi/${entregaId}/despachar`)
        .set(tecnico())
        .expect(400);
      expect(sinRenglones.body.detail).toMatch(/al menos un elemento/);

      // un elemento que exige talla no se acepta sin ella
      const el = elemento('guantes_nitrilo');
      await http()
        .put(`/api/qhse/epi/${entregaId}/contenido`)
        .set(tecnico())
        .send({
          lugarBodegaId: BODEGA.id,
          renglones: [{ elementoId: el.id, cantidad: 1, recibioCapacitacion: true }],
        })
        .expect(400);
      // un elemento que no existe en el catálogo tampoco
      await http()
        .put(`/api/qhse/epi/${entregaId}/contenido`)
        .set(tecnico())
        .send({
          renglones: [{ elementoId: uuidv7(), cantidad: 1, recibioCapacitacion: false }],
        })
        .expect(400);

      await http()
        .put(`/api/qhse/epi/${entregaId}/contenido`)
        .set(tecnico())
        .send({ renglones: [renglon(false), renglon(true)] })
        .expect(200);
      const sinLugar = await http()
        .post(`/api/qhse/epi/${entregaId}/despachar`)
        .set(tecnico())
        .expect(400);
      expect(sinLugar.body.detail).toMatch(/lugar/);

      await http()
        .put(`/api/qhse/epi/${entregaId}/contenido`)
        .set(tecnico())
        .send({ lugarBodegaId: BODEGA.id, renglones: [renglon(false), renglon(true)] })
        .expect(200);
      const sinFirma = await http()
        .post(`/api/qhse/epi/${entregaId}/despachar`)
        .set(tecnico())
        .expect(400);
      expect(sinFirma.body.detail).toMatch(/declaración del trabajador/);
    });

    it('despacha con todo completo, publica qhse.epi.despachada como pide el contrato y ya no deja editar los renglones', async () => {
      await http().post(`/api/qhse/epi/${entregaId}/firma-trabajador`).set(tecnico()).expect(201);
      await http().post(`/api/qhse/epi/${entregaId}/firma-trabajador`).set(tecnico()).expect(409);
      // Talento Humano firma después del despacho, no antes
      await http()
        .post(`/api/qhse/epi/${entregaId}/firma-talento-humano`)
        .set(tecnico())
        .expect(409);

      const r = await http()
        .post(`/api/qhse/epi/${entregaId}/despachar`)
        .set(gerente())
        .expect(201);
      expect(r.body).toMatchObject({
        estado: 'despachado',
        despachado: { usuarioId: GERENTE.id },
        aprobado: { usuarioId: TECNICO.id },
        firmaTrabajador: { usuarioId: TECNICO.id },
      });
      expect(r.body.renglones).toHaveLength(2);

      const pub = (await salida(entregaId)).find((p) => p.tipo === 'qhse.epi.despachada');
      expect(pub).toBeDefined();
      // el contrato 3: source `qhse`, y datos obligatorios `ticketId` y `usuarioId` (el operador que recibió el EPI)
      expect(pub?.datos.source).toBe('qhse');
      expect(pub?.datos.data).toMatchObject({ ticketId, usuarioId: OP1.id, entregaId });

      await http()
        .put(`/api/qhse/epi/${entregaId}/contenido`)
        .set(tecnico())
        .send({ renglones: [renglon(false)] })
        .expect(409);
      await http()
        .post(`/api/qhse/epi/${entregaId}/firma-talento-humano`)
        .set(tecnico())
        .expect(201);
    });

    it('revertir exige motivo, vuelve a aprobado y publica qhse.epi.revertida; todo queda en el historial', async () => {
      await http()
        .post(`/api/qhse/epi/${entregaId}/revertir`)
        .set(tecnico())
        .send({ motivo: '  ' })
        .expect(400);
      const r = await http()
        .post(`/api/qhse/epi/${entregaId}/revertir`)
        .set(tecnico())
        .send({ motivo: 'Se despachó a otro trabajador por error' })
        .expect(201);
      expect(r.body.estado).toBe('aprobado');
      expect(r.body.despachado).toBeNull();

      const tipos = (await salida(entregaId)).map((p) => p.tipo);
      expect(tipos).toEqual(
        expect.arrayContaining(['qhse.epi.aprobada', 'qhse.epi.despachada', 'qhse.epi.revertida']),
      );
      const rev = (await salida(entregaId)).find((p) => p.tipo === 'qhse.epi.revertida');
      expect(rev?.datos.data).toMatchObject({ ticketId, usuarioId: OP1.id });

      expect(r.body.historial.map((h: { estadoNuevo: string }) => h.estadoNuevo)).toEqual([
        'solicitado',
        'aprobado',
        'despachado',
        'aprobado',
      ]);
      expect(r.body.historial[3].motivo).toMatch(/por error/);
    });

    it('se puede volver a despachar tras corregir (los renglones vuelven a ser editables)', async () => {
      await http().post(`/api/qhse/epi/${entregaId}/despachar`).set(tecnico()).expect(201);
      await http()
        .post(`/api/qhse/epi/${entregaId}/revertir`)
        .set(tecnico())
        .send({ motivo: 'Otra corrección' })
        .expect(201);
      await http()
        .put(`/api/qhse/epi/${entregaId}/contenido`)
        .set(tecnico())
        .send({ renglones: [renglon(false)] })
        .expect(200);
    });
  });

  describe('rechazo', () => {
    it('exige motivo, no se despacha, y permite abrir una nueva solicitud para el mismo trabajador y ticket', async () => {
      const ticketId = uuidv7();
      await consumer.consumir(eventoAsignacion(ticketId, [OP2.id]));
      await solicitarAMano(ticketId, OP2.id);
      const [primera] = await entregasDe(ticketId);

      await http().post(`/api/qhse/epi/${primera.id}/rechazar`).set(tecnico()).send({}).expect(400);
      await http()
        .post(`/api/qhse/epi/${primera.id}/rechazar`)
        .set(tecnico())
        .send({ motivo: '' })
        .expect(400);
      // mientras esté vigente no se puede abrir otra a mano
      await http()
        .post('/api/qhse/epi')
        .set(tecnico())
        .send({ trabajadorId: OP2.id, ticketId })
        .expect(409);

      const r = await http()
        .post(`/api/qhse/epi/${primera.id}/rechazar`)
        .set(tecnico())
        .send({ motivo: 'El trabajador ya recibió su dotación este mes' })
        .expect(201);
      expect(r.body).toMatchObject({
        estado: 'rechazado',
        rechazado: {
          usuarioId: TECNICO.id,
          motivo: 'El trabajador ya recibió su dotación este mes',
        },
      });
      await http().post(`/api/qhse/epi/${primera.id}/aprobar`).set(tecnico()).expect(409);
      await http().post(`/api/qhse/epi/${primera.id}/despachar`).set(tecnico()).expect(409);
      await http().post(`/api/qhse/epi/${primera.id}/firma-trabajador`).set(tecnico()).expect(409);

      const nueva = await http()
        .post('/api/qhse/epi')
        .set(tecnico())
        .send({
          trabajadorId: OP2.id,
          ticketId,
          lugarBodegaId: BODEGA.id,
          renglones: [renglon(false)],
        })
        .expect(201);
      expect(nueva.body).toMatchObject({
        estado: 'solicitado',
        lugar: { id: BODEGA.id, nombre: BODEGA.nombre },
      });
      expect(nueva.body.renglones).toHaveLength(1);
      expect((await entregasDe(ticketId)).length).toBe(2);
    });
  });

  describe('registro manual', () => {
    it('permite una entrega sin ticket (p. ej. de oficina) y rechaza trabajadores inactivos o tickets desconocidos', async () => {
      const sinTicket = await http()
        .post('/api/qhse/epi')
        .set(tecnico())
        .send({ trabajadorId: OP1.id, lugarBodegaId: BODEGA.id })
        .expect(201);
      expect(sinTicket.body.ticket).toBeNull();
      const pub = await salida(sinTicket.body.id);
      expect(pub.map((p) => p.tipo)).toEqual(['qhse.epi.solicitada']);
      await admin.query('DELETE FROM qhse.epi_entrega WHERE id = $1', [sinTicket.body.id]);
      await admin.query("DELETE FROM msg_qhse.outbox WHERE datos->'data'->>'entregaId' = $1", [
        sinTicket.body.id,
      ]);

      await http()
        .post('/api/qhse/epi')
        .set(tecnico())
        .send({ trabajadorId: OP_INACTIVO.id })
        .expect(400);
      await http()
        .post('/api/qhse/epi')
        .set(tecnico())
        .send({ trabajadorId: uuidv7() })
        .expect(400);
      const ticketDesconocido = await http()
        .post('/api/qhse/epi')
        .set(tecnico())
        .send({ trabajadorId: OP1.id, ticketId: uuidv7() })
        .expect(400);
      expect(ticketDesconocido.body.detail).toMatch(/no es conocido por QHSE/);
    });

    it('rechaza cantidades inválidas y campos no declarados', async () => {
      await http()
        .post('/api/qhse/epi')
        .set(tecnico())
        .send({ trabajadorId: OP1.id, renglones: [{ ...renglon(false), cantidad: 0 }] })
        .expect(400);
      await http()
        .post('/api/qhse/epi')
        .set(tecnico())
        .send({ trabajadorId: OP1.id, estado: 'despachado' })
        .expect(400);
    });

    it('el catálogo de elementos trae los activos, con su regla de talla', async () => {
      const r = await http().get('/api/qhse/epi/elementos').set(soloVer()).expect(200);
      expect(r.body.find((x: { codigo: string }) => x.codigo === codigoDe('casco'))).toMatchObject({
        tipoTalla: null,
      });
      expect(r.body.find((x: { codigo: string }) => x.codigo === codigoDe('overol'))).toMatchObject(
        {
          tipoTalla: 'ropa',
        },
      );
      const t = await http().get('/api/qhse/epi/tallas').set(soloVer()).expect(200);
      expect(t.body.filter((x: { tipo: string }) => x.tipo === 'calzado')).toHaveLength(12);
      const l = await http().get('/api/qhse/epi/lugares').set(soloVer()).expect(200);
      expect(l.body.some((x: { id: string }) => x.id === BODEGA.id)).toBe(true);
    });
  });

  // ------------------------------------------------------------------------------------------------ réplica de artículos

  describe('elementos de EPI: réplica de los artículos de Inventario (evento)', () => {
    const fila = (articuloId: string) => prisma.epiElemento.findUnique({ where: { articuloId } });

    it('un artículo que se entrega a una persona entra al catálogo; un evento repetido no lo duplica', async () => {
      const articuloId = uuidv7();
      const e = eventoArticulo(articuloId, 'botas', { tipoTalla: 'calzado' });
      await articulosEpi.consumir(e);
      await articulosEpi.consumir(e); // repetido: lo ignora el inbox
      expect(await fila(articuloId)).toMatchObject({
        codigo: codigoDe('botas'),
        nombre: 'Elemento de prueba botas',
        tipoTalla: 'calzado',
        activo: true,
      });
      expect(await prisma.epiElemento.count({ where: { articuloId } })).toBe(1);
    });

    it('un cambio posterior actualiza el elemento; uno más viejo no pisa al más nuevo', async () => {
      const articuloId = uuidv7();
      await articulosEpi.consumir(
        eventoArticulo(articuloId, 'gafas', {}, '2026-11-02T10:00:00.000Z'),
      );
      await articulosEpi.consumir(
        eventoArticulo(articuloId, 'gafas', { nombre: 'Gafas nuevas' }, '2026-11-02T12:00:00.000Z'),
      );
      await articulosEpi.consumir(
        eventoArticulo(articuloId, 'gafas', { nombre: 'Gafas viejas' }, '2026-11-02T11:00:00.000Z'),
      );
      expect((await fila(articuloId))?.nombre).toBe('Gafas nuevas');
    });

    it('si el artículo deja de entregarse a una persona o se da de baja, el elemento se desactiva (no se borra)', async () => {
      const a = uuidv7();
      const b = uuidv7();
      await articulosEpi.consumir(eventoArticulo(a, 'tapones', {}, '2026-11-03T10:00:00.000Z'));
      await articulosEpi.consumir(eventoArticulo(b, 'orejeras', {}, '2026-11-03T10:00:00.000Z'));
      await articulosEpi.consumir(
        eventoArticulo(a, 'tapones', { entregaPersonal: false }, '2026-11-03T11:00:00.000Z'),
      );
      await articulosEpi.consumir(
        eventoArticulo(b, 'orejeras', { activo: false }, '2026-11-03T11:00:00.000Z'),
      );
      expect((await fila(a))?.activo).toBe(false);
      expect((await fila(b))?.activo).toBe(false);
      const r = await http().get('/api/qhse/epi/elementos').set(soloVer()).expect(200);
      const codigos = r.body.map((x: { codigo: string }) => x.codigo);
      expect(codigos).not.toContain(codigoDe('tapones'));
      expect(codigos).not.toContain(codigoDe('orejeras'));
    });

    it('un artículo que nunca se entregó a una persona no entra; un evento incompleto o con una talla inválida se ignora sin error', async () => {
      const noEntra = uuidv7();
      await articulosEpi.consumir(eventoArticulo(noEntra, 'extintor', { entregaPersonal: false }));
      expect(await fila(noEntra)).toBeNull();
      const incompleto = uuidv7();
      await articulosEpi.consumir(eventoArticulo(incompleto, 'sin_nombre', { nombre: '' }));
      await articulosEpi.consumir(
        eventoArticulo(incompleto, 'talla_mala', { tipoTalla: 'sombrero' }),
      );
      expect(await fila(incompleto)).toBeNull();
    });

    it('la base no permite dos elementos del mismo artículo ni del mismo código', async () => {
      const articuloId = uuidv7();
      await articulosEpi.consumir(eventoArticulo(articuloId, 'unico'));
      await expect(
        admin.query(
          "INSERT INTO qhse.epi_elemento (id, articulo_id, codigo, nombre) VALUES ($1, $2, $3, 'otro')",
          [uuidv7(), articuloId, `${codigoDe('distinto')}`],
        ),
      ).rejects.toThrow(/epi_elemento_articulo_id_key/);
      await expect(
        admin.query(
          "INSERT INTO qhse.epi_elemento (id, articulo_id, codigo, nombre) VALUES ($1, $2, $3, 'otro')",
          [uuidv7(), uuidv7(), codigoDe('unico')],
        ),
      ).rejects.toThrow(/epi_elemento_codigo_key/);
    });
  });

  // ------------------------------------------------------------------------------------------------ permisos

  describe('permisos', () => {
    let entregaId: string;
    beforeAll(async () => {
      const ticketId = uuidv7();
      await consumer.consumir(eventoAsignacion(ticketId, [OP1.id]));
      await solicitarAMano(ticketId, OP1.id);
      entregaId = (await entregasDe(ticketId))[0].id;
    });

    it('el Supervisor y quien no tiene permisos no entran a QHSE', async () => {
      await http().get('/api/qhse/epi').set(supervisor()).expect(403);
      await http().get(`/api/qhse/epi/${entregaId}`).set(supervisor()).expect(403);
      await http().post(`/api/qhse/epi/${entregaId}/aprobar`).set(supervisor()).expect(403);
      await http().get('/api/qhse/epi').expect(401);
    });

    it('quien solo puede ver no crea, aprueba, despacha ni firma', async () => {
      await http().get('/api/qhse/epi').set(soloVer()).expect(200);
      await http().post('/api/qhse/epi').set(soloVer()).send({ trabajadorId: OP1.id }).expect(403);
      await http().post(`/api/qhse/epi/${entregaId}/aprobar`).set(soloVer()).expect(403);
      await http()
        .post(`/api/qhse/epi/${entregaId}/rechazar`)
        .set(soloVer())
        .send({ motivo: 'x' })
        .expect(403);
      await http().post(`/api/qhse/epi/${entregaId}/despachar`).set(soloVer()).expect(403);
      await http()
        .post(`/api/qhse/epi/${entregaId}/firma-talento-humano`)
        .set(soloVer())
        .expect(403);
    });

    it('un id mal formado responde 400 y uno inexistente 404', async () => {
      await http().get('/api/qhse/epi/no-es-un-uuid').set(tecnico()).expect(400);
      await http().get(`/api/qhse/epi/${uuidv7()}`).set(tecnico()).expect(404);
    });
  });

  // ------------------------------------------------------------------------------------------------ base de datos

  describe('reglas en la base de datos', () => {
    it('la base impide un estado incoherente aunque la aplicación se equivoque', async () => {
      const ticketId = uuidv7();
      await consumer.consumir(eventoAsignacion(ticketId, [OP2.id]));
      await solicitarAMano(ticketId, OP2.id);
      const [e] = await entregasDe(ticketId);
      await expect(
        admin.query("UPDATE qhse.epi_entrega SET estado = 'despachado' WHERE id = $1", [e.id]),
      ).rejects.toThrow(/epi_entrega_estado_check/);
      await expect(
        admin.query(
          "UPDATE qhse.epi_entrega SET estado = 'rechazado', rechazado_por = $2, rechazado_at = now() WHERE id = $1",
          [e.id, TECNICO.id],
        ),
      ).rejects.toThrow(/epi_entrega_estado_check/);
    });

    it('el historial es un rastro: la aplicación puede agregar, pero no modificar ni borrar', async () => {
      const [h] = await prisma.epiEntregaHistorial.findMany({ take: 1 });
      await expect(
        prisma.$executeRawUnsafe(
          'UPDATE qhse.epi_entrega_historial SET motivo = $1 WHERE id = $2::uuid',
          'x',
          h.id,
        ),
      ).rejects.toThrow();
      await expect(
        prisma.$executeRawUnsafe(
          'DELETE FROM qhse.epi_entrega_historial WHERE id = $1::uuid',
          h.id,
        ),
      ).rejects.toThrow();
    });

    it('un trabajador no puede tener dos solicitudes vigentes del mismo ticket (índice único parcial)', async () => {
      const ticketId = uuidv7();
      await consumer.consumir(eventoAsignacion(ticketId, [OP1.id]));
      await solicitarAMano(ticketId, OP1.id);
      await expect(
        prisma.epiEntrega.create({ data: { id: uuidv7(), trabajadorId: OP1.id, ticketId } }),
      ).rejects.toThrow();
    });

    /** Una entrega despachada por la API, para probar lo que la base impide aunque el servicio se equivoque. */
    const despachada = async () => {
      const ticketId = uuidv7();
      await consumer.consumir(eventoAsignacion(ticketId, [OP1.id]));
      await solicitarAMano(ticketId, OP1.id);
      const [e] = await entregasDe(ticketId);
      await http().post(`/api/qhse/epi/${e.id}/aprobar`).set(tecnico()).expect(201);
      await http()
        .put(`/api/qhse/epi/${e.id}/contenido`)
        .set(tecnico())
        .send({ lugarBodegaId: BODEGA.id, renglones: [renglon(false), renglon(true)] })
        .expect(200);
      await http().post(`/api/qhse/epi/${e.id}/firma-trabajador`).set(tecnico()).expect(201);
      await http().post(`/api/qhse/epi/${e.id}/despachar`).set(tecnico()).expect(201);
      return e.id;
    };

    it('tras el despacho la base no deja agregar, cambiar ni quitar renglones, ni tocar la entrega firmada', async () => {
      const id = await despachada();
      const [item] = await prisma.epiEntregaItem.findMany({ where: { entregaId: id } });
      await expect(
        prisma.epiEntregaItem.create({
          data: {
            id: uuidv7(),
            entregaId: id,
            elementoId: elemento('casco').id,
            cantidad: 1,
            recibioCapacitacion: true,
          },
        }),
      ).rejects.toThrow(/no se pueden cambiar/);
      await expect(
        prisma.epiEntregaItem.update({ where: { id: item.id }, data: { cantidad: 99 } }),
      ).rejects.toThrow(/no se pueden cambiar/);
      await expect(prisma.epiEntregaItem.delete({ where: { id: item.id } })).rejects.toThrow(
        /no se pueden cambiar/,
      );
      // la cabecera firmada tampoco se reescribe (ni el lugar ni el trabajador), pero Talento Humano sí puede completar su firma
      await expect(
        prisma.epiEntrega.update({ where: { id }, data: { lugarBodegaId: null } }),
      ).rejects.toThrow(/no se puede modificar/);
      await expect(
        prisma.epiEntrega.update({ where: { id }, data: { trabajadorId: OP2.id } }),
      ).rejects.toThrow(/no se puede modificar/);
      await http().post(`/api/qhse/epi/${id}/firma-talento-humano`).set(tecnico()).expect(201);
      // y una entrega rechazada tampoco admite renglones
      const ticketId = uuidv7();
      await consumer.consumir(eventoAsignacion(ticketId, [OP2.id]));
      await solicitarAMano(ticketId, OP2.id);
      const [r] = await entregasDe(ticketId);
      await http()
        .post(`/api/qhse/epi/${r.id}/rechazar`)
        .set(tecnico())
        .send({ motivo: 'No corresponde' })
        .expect(201);
      await expect(
        prisma.epiEntregaItem.create({
          data: {
            id: uuidv7(),
            entregaId: r.id,
            elementoId: elemento('casco').id,
            cantidad: 1,
            recibioCapacitacion: false,
          },
        }),
      ).rejects.toThrow(/no se pueden cambiar/);
    });

    it('la talla debe ser del tipo que lleva el elemento (la base lo exige aunque el servicio no lo revise)', async () => {
      const ticketId = uuidv7();
      await consumer.consumir(eventoAsignacion(ticketId, [OP1.id]));
      await solicitarAMano(ticketId, OP1.id);
      const [e] = await entregasDe(ticketId);
      const base = { entregaId: e.id, cantidad: 1, recibioCapacitacion: false };
      const nuevoItem = (elementoId: string, tallaId?: string) =>
        prisma.epiEntregaItem.create({
          data: { id: uuidv7(), elementoId, tallaId: tallaId ?? null, ...base },
        });
      // guantes con una talla de calzado, guantes sin talla y casco con talla
      await expect(
        nuevoItem(elemento('guantes_nitrilo').id, talla('calzado', '40').id),
      ).rejects.toThrow(/no es del tipo/);
      await expect(nuevoItem(elemento('guantes_nitrilo').id)).rejects.toThrow(/exige una talla/);
      await expect(nuevoItem(elemento('casco').id, talla('ropa', 'M').id)).rejects.toThrow(
        /no lleva talla/,
      );
      await expect(
        nuevoItem(elemento('guantes_nitrilo').id, talla('guante', '8').id),
      ).resolves.toBeDefined();
      // y el servicio da el mismo rechazo con un mensaje claro
      const r = await http()
        .put(`/api/qhse/epi/${e.id}/contenido`)
        .set(tecnico())
        .send({
          renglones: [
            {
              elementoId: elemento('overol').id,
              cantidad: 1,
              recibioCapacitacion: true,
              tallaId: talla('calzado', '40').id,
            },
          ],
        })
        .expect(400);
      expect(r.body.detail).toMatch(/talla indicada no corresponde/);
    });

    it('el lugar y la talla son catálogos con FK, y el historial no admite borrar', async () => {
      const ticketId = uuidv7();
      await consumer.consumir(eventoAsignacion(ticketId, [OP2.id]));
      await solicitarAMano(ticketId, OP2.id);
      const [e] = await entregasDe(ticketId);
      await expect(
        prisma.epiEntrega.update({ where: { id: e.id }, data: { lugarBodegaId: uuidv7() } }),
      ).rejects.toThrow();
      await http()
        .put(`/api/qhse/epi/${e.id}/contenido`)
        .set(tecnico())
        .send({ lugarBodegaId: uuidv7(), renglones: [] })
        .expect(400);
      const [h] = await prisma.epiEntregaHistorial.findMany({ where: { entregaId: e.id } });
      await expect(
        prisma.$executeRawUnsafe(
          'DELETE FROM qhse.epi_entrega_historial WHERE id = $1::uuid',
          h.id,
        ),
      ).rejects.toThrow(/permission denied|denegado/i);
    });

    it('cada renglón queda auditado con quién lo registró', async () => {
      const id = await despachada();
      const items = await prisma.epiEntregaItem.findMany({ where: { entregaId: id } });
      expect(items.length).toBe(2);
      expect(items.every((i) => i.createdBy === TECNICO.id && i.updatedBy === TECNICO.id)).toBe(
        true,
      );
    });
  });
});
