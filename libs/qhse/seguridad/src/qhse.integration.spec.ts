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
const MAESTROS: MaestrosDePrueba = {
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
  let elementos: Array<{ id: string; nombre: string; requiereTalla: boolean }> = [];
  const renglon = (conTalla = false) => {
    const el = elementos.find((e) => e.requiereTalla === conTalla) as (typeof elementos)[number];
    return {
      elementoId: el.id,
      cantidad: 2,
      ...(conTalla ? { talla: 'L' } : {}),
      recibioCapacitacion: true,
    };
  };

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
    await app.init();
    prisma = app.get(PrismaService);
    consumer = app.get(PumpingEventosConsumer);
    elementos = await prisma.epiElemento.findMany({
      where: { activo: true },
      select: { id: true, nombre: true, requiereTalla: true },
    });
  });

  afterAll(async () => {
    if (tickets.length) {
      // las entregas (y sus renglones e historial) caen en cascada; `app_qhse` no borra cabeceras, por eso va dyn_migrator
      await admin.query('DELETE FROM qhse.epi_entrega WHERE ticket_id = ANY($1::uuid[])', [
        tickets,
      ]);
      await admin.query('DELETE FROM qhse.ticket_ref WHERE ticket_id = ANY($1::uuid[])', [tickets]);
    }
    await admin.query('DELETE FROM qhse.epi_entrega WHERE trabajador_id = ANY($1::uuid[])', [
      [OP1.id, OP2.id, OP_INACTIVO.id],
    ]);
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

  it('abre una solicitud de EPI por cada operador asignado (no por el supervisor) y recuerda el ticket', async () => {
    const ticketId = uuidv7();
    const e = eventoAsignacion(ticketId, [OP1.id, OP2.id]);
    await consumer.consumir(e);

    const ref = await prisma.ticketRef.findUniqueOrThrow({ where: { ticketId } });
    expect(ref).toMatchObject({ pedidoCodigo: `PED-QH${n}`, ticketNumero: e.data['ticketNumero'] });
    const entregas = await entregasDe(ticketId);
    expect(entregas.map((x) => x.trabajadorId).sort()).toEqual([OP1.id, OP2.id].sort());
    expect(entregas.every((x) => x.estado === 'solicitado')).toBe(true);
    expect(entregas.every((x) => x.createdBy === JEFE.id)).toBe(true);
    const hist = await prisma.epiEntregaHistorial.findMany({
      where: { entregaId: entregas[0].id },
    });
    expect(hist).toHaveLength(1);
    expect(hist[0]).toMatchObject({ estadoAnterior: null, estadoNuevo: 'solicitado' });
    // avisa a QHSE con un evento propio (source = qhse)
    const pub = await salida(entregas[0].id);
    expect(pub.map((p) => p.tipo)).toEqual(['qhse.epi.solicitada']);
    expect(pub[0].datos.source).toBe('qhse');
    // y un solo aviso por asignación (no uno por operador) para el equipo de QHSE, con el texto que necesita la plantilla
    const avisos = await salidaDeTicket(ticketId, 'qhse.epi.solicitudes_abiertas');
    expect(avisos).toHaveLength(1);
    expect(avisos[0].datos.data).toMatchObject({
      ticketId,
      pedidoCodigo: `PED-QH${n}`,
      cliente: 'Cliente de prueba',
      cantidad: 2,
    });
    expect(String(avisos[0].datos.data['trabajadores']).split(', ').sort()).toEqual(
      [OP1.nombre, OP2.nombre].sort(),
    );
  });

  it('es idempotente: el mismo evento, o una reasignación con los mismos operadores, no duplica las solicitudes', async () => {
    const ticketId = uuidv7();
    const e = eventoAsignacion(ticketId, [OP1.id]);
    await consumer.consumir(e);
    await consumer.consumir(e);
    await consumer.consumir(
      eventoAsignacion(ticketId, [OP1.id, OP2.id], { pedidoId: e.data['pedidoId'] }),
    );
    const entregas = await entregasDe(ticketId);
    expect(entregas.map((x) => x.trabajadorId).sort()).toEqual([OP1.id, OP2.id].sort());
    // un aviso por asignación que abrió algo: el evento repetido no avisa de nuevo, y la reasignación avisa solo de quien faltaba
    const avisos = await salidaDeTicket(ticketId, 'qhse.epi.solicitudes_abiertas');
    expect(avisos.map((a) => a.datos.data['cantidad'])).toEqual([1, 1]);
    expect(avisos[1].datos.data['trabajadores']).toBe(OP2.nombre);
  });

  it('ignora sin error un evento sin ticket o sin pedido, y a los operadores que no existen o están inactivos', async () => {
    const sinTicket = eventoAsignacion(uuidv7(), [OP1.id]);
    delete sinTicket.data['ticketId'];
    await expect(consumer.consumir(sinTicket)).resolves.toBeUndefined();

    const ticketId = uuidv7();
    await consumer.consumir(eventoAsignacion(ticketId, [uuidv7(), OP_INACTIVO.id]));
    expect(await entregasDe(ticketId)).toHaveLength(0);
    // el ticket sí quedó referenciado: se conoce aunque nadie reciba EPI
    expect(await prisma.ticketRef.count({ where: { ticketId } })).toBe(1);
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

  // ------------------------------------------------------------------------------------------------ ciclo de vida

  describe('ciclo de vida de una entrega', () => {
    let ticketId: string;
    let entregaId: string;

    beforeAll(async () => {
      ticketId = uuidv7();
      await consumer.consumir(eventoAsignacion(ticketId, [OP1.id]));
      entregaId = (await entregasDe(ticketId))[0].id;
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
      const el = elementos.find((x) => x.requiereTalla) as (typeof elementos)[number];
      await http()
        .put(`/api/qhse/epi/${entregaId}/contenido`)
        .set(tecnico())
        .send({
          lugar: 'Base Shushufindi',
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
        .send({ lugar: 'Base Shushufindi', renglones: [renglon(false), renglon(true)] })
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
          lugar: 'Base Lago Agrio',
          renglones: [renglon(false)],
        })
        .expect(201);
      expect(nueva.body).toMatchObject({ estado: 'solicitado', lugar: 'Base Lago Agrio' });
      expect(nueva.body.renglones).toHaveLength(1);
      expect((await entregasDe(ticketId)).length).toBe(2);
    });
  });

  describe('registro manual', () => {
    it('permite una entrega sin ticket (p. ej. de oficina) y rechaza trabajadores inactivos o tickets desconocidos', async () => {
      const sinTicket = await http()
        .post('/api/qhse/epi')
        .set(tecnico())
        .send({ trabajadorId: OP1.id, lugar: 'Oficina Quito' })
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
      expect(r.body.length).toBeGreaterThanOrEqual(12);
      expect(
        r.body.find((x: { nombre: string }) => x.nombre === 'Casco de seguridad'),
      ).toMatchObject({
        requiereTalla: false,
      });
      expect(r.body.find((x: { nombre: string }) => x.nombre === 'Overol')).toMatchObject({
        requiereTalla: true,
      });
    });
  });

  // ------------------------------------------------------------------------------------------------ permisos

  describe('permisos', () => {
    let entregaId: string;
    beforeAll(async () => {
      const ticketId = uuidv7();
      await consumer.consumir(eventoAsignacion(ticketId, [OP1.id]));
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
      await expect(
        prisma.epiEntrega.create({ data: { id: uuidv7(), trabajadorId: OP1.id, ticketId } }),
      ).rejects.toThrow();
    });
  });
});
