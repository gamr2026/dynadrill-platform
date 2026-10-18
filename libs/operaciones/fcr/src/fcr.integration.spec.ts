/**
 * Integración real de FCR: Postgres (PgBouncer, app_operaciones). El receptor de pedidos abiertos se prueba llamando a `consumir` con un
 * evento como el que publica `comercial` (sin RabbitMQ). Limpia lo que crea.
 *   RUN_INTEGRATION=1 npx nx test fcr
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
import { DespachosConsumer } from '@dyn/inventario';
import { MessagingModule, type EventEnvelope } from '@dyn/messaging';
import { uuidv7 } from '@dyn/utils';
import { PedidosAbiertosConsumer } from './consumers/pedidos-abiertos.consumer';
import { FcrModule } from './fcr.module';
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
const SUPERVISOR = { id: uuidv7(), nombre: 'Sara Supervisora FCR' };
const OTRO_SUPERVISOR = { id: uuidv7(), nombre: 'Saúl Supervisor FCR' };
const SUPERVISOR_OPS = { id: uuidv7(), nombre: 'Sofía Supervisora de Operaciones' };
const INSPECTOR = { id: uuidv7(), nombre: 'Iván Inspector FCR' };
const OPERADOR = { id: uuidv7(), nombre: 'Olga Operadora FCR' };
const OTRO_OPERADOR = { id: uuidv7(), nombre: 'Omar Operador FCR' };
const SUPERVISOR_PUMPING = { id: uuidv7(), nombre: 'Pablo Supervisor Pumping' };
const OPERADOR_PUMPING = { id: uuidv7(), nombre: 'Pía Operadora Pumping' };
const BODEGUERO = { id: uuidv7(), nombre: 'Bruno Bodeguero' };
const JEFE = { id: uuidv7(), nombre: 'Jaime Jefe de Base' };
const CLIENTE = { id: uuidv7(), nombre: `Cliente FCR ${n}`, ruc: `87${String(n).slice(-11)}` };
const CAMPO = { id: uuidv7(), nombre: `SACHA FCR ${n}` };
const BLOQUE = { id: uuidv7(), nombre: `Bloque 60 FCR ${n}` };
const POZO = { id: uuidv7(), nombre: `FCR-POZO-${n}`, campoId: CAMPO.id, bloqueId: BLOQUE.id };
const VEHICULO = { id: uuidv7(), placa: `FC${String(n).slice(-5)}A` };
const VEHICULO_AJENO = { id: uuidv7(), placa: `FC${String(n).slice(-5)}B` };
const MAESTROS: MaestrosDePrueba = {
  usuarios: [
    { id: SUPERVISOR.id, nombre: SUPERVISOR.nombre, rol: 'supervisor' },
    { id: OTRO_SUPERVISOR.id, nombre: OTRO_SUPERVISOR.nombre, rol: 'supervisor' },
    { id: SUPERVISOR_OPS.id, nombre: SUPERVISOR_OPS.nombre, rol: 'supervisor_operaciones_fcr' },
    { id: INSPECTOR.id, nombre: INSPECTOR.nombre, rol: 'operador_fcr' },
    { id: OPERADOR.id, nombre: OPERADOR.nombre, rol: 'operador_fcr' },
    { id: OTRO_OPERADOR.id, nombre: OTRO_OPERADOR.nombre, rol: 'operador_fcr' },
    { id: SUPERVISOR_PUMPING.id, nombre: SUPERVISOR_PUMPING.nombre, rol: 'supervisor_pumping' },
    { id: OPERADOR_PUMPING.id, nombre: OPERADOR_PUMPING.nombre, rol: 'operador' },
    { id: BODEGUERO.id, nombre: BODEGUERO.nombre, rol: 'bodeguero' },
    { id: JEFE.id, nombre: JEFE.nombre, rol: 'jefe_base' },
  ],
  clientes: [CLIENTE],
  campos: [CAMPO],
  bloques: [BLOQUE],
  pozos: [POZO],
  vehiculos: [VEHICULO, VEHICULO_AJENO],
};

run(
  'FCR: tickets de los pedidos abiertos, los dos recorridos y la asignación (base de datos real)',
  () => {
    jest.setTimeout(90000);
    let app: INestApplication;
    let prisma: PrismaService;
    let consumer: PedidosAbiertosConsumer;
    const admin = new Pool({ connectionString: MIGRATOR_DB, max: 2 });
    const appPool = new Pool({ connectionString: APP_DB, max: 2 });
    const http = () => request(app.getHttpServer());
    const signer = new JwtService({
      privateKey,
      signOptions: { algorithm: 'RS256', issuer: 'dynadrill-plataforma', expiresIn: 600 },
    });
    const token = (roleCode: string, name: string, permissions: string[], sub = uuidv7()) => ({
      Authorization: `Bearer ${signer.sign({ sub, email: `${roleCode}@test.local`, name, roleId: 'r', roleCode, permissions })}`,
    });
    const supervisor = () => token('supervisor', SUPERVISOR.nombre, [P.FCR_OPERAR], SUPERVISOR.id);
    const otroSupervisor = () =>
      token('supervisor', OTRO_SUPERVISOR.nombre, [P.FCR_OPERAR], OTRO_SUPERVISOR.id);
    const supervisorOps = () =>
      token('supervisor_operaciones_fcr', SUPERVISOR_OPS.nombre, [P.FCR_OPERAR], SUPERVISOR_OPS.id);
    const inspector = () => token('operador_fcr', INSPECTOR.nombre, [P.FCR_OPERAR], INSPECTOR.id);
    const operador = () => token('operador_fcr', OPERADOR.nombre, [P.FCR_OPERAR], OPERADOR.id);
    const otroOperador = () =>
      token('operador_fcr', OTRO_OPERADOR.nombre, [P.FCR_OPERAR], OTRO_OPERADOR.id);
    const jefe = () =>
      token('jefe_base', JEFE.nombre, [P.FCR_OPERAR, P.FCR_REQUISITOS_PUENTE], JEFE.id);
    const sinPermiso = () => token('ingenieria_ventas', 'Vera Ventas', []);

    const pedidos: string[] = [];
    const eventos: string[] = [];
    /** Números de ticket de prueba (únicos): en producción los reserva `comercial` del secuencial de la prefactura. */
    let ticketSeq = 700_000 + (n % 100_000) * 10;

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
          codigo: `PED-FCR${n}`,
          lineaServicio: 'fcr',
          tipoOt: 'venta',
          tiposServicio: ['pesca'],
          ticketNumero: ticketSeq++,
          clienteId: CLIENTE.id,
          campoId: CAMPO.id,
          bloqueId: BLOQUE.id,
          pozoId: POZO.id,
          taladroId: null,
          rigless: false,
          numeroContrato: 'CT-IT',
          fechaInicioServicio: '2026-11-05',
          fechaFinServicio: '2026-11-12',
          as2Numero: null,
          ...extra.data,
        },
      } as EventEnvelope;
    };

    /** Crea el ticket del pedido y devuelve su id. */
    const crear = async (data: Record<string, unknown> = {}) => {
      const e = evento({ data });
      await consumer.consumir(e);
      const t = await prisma.ticket.findUniqueOrThrow({ where: { pedidoId: e.subject.id } });
      return { id: t.id, pedidoId: e.subject.id };
    };
    const avanzar = (id: string, hacia: string, auth = supervisor(), motivo?: string) =>
      http()
        .post(`/api/operaciones/fcr/tickets/${id}/avanzar`)
        .set(auth)
        .send({ hacia, ...(motivo ? { motivo } : {}) });
    const detalle = async (id: string, auth = supervisor()) =>
      (await http().get(`/api/operaciones/fcr/tickets/${id}`).set(auth).expect(200)).body;
    const salidas = async (pedidoId: string) =>
      (
        await admin.query(
          "SELECT tipo, datos FROM msg_operaciones.outbox WHERE datos->'data'->>'pedidoId' = $1 ORDER BY ocurrido_at, id",
          [pedidoId],
        )
      ).rows as Array<{ tipo: string; datos: { data: Record<string, unknown> } }>;

    /** El pedido de estas pruebas no tiene herramientas: solo falta confirmar el listado para salir de la preparación. */
    const confirmarListado = async (id: string, auth = supervisor()) =>
      http()
        .post(`/api/operaciones/fcr/tickets/${id}/herramientas/confirmar-listado`)
        .set(auth)
        .send({ confirmado: true })
        .expect(201);

    /** Lleva un ticket de venta hasta el paso de Asignación, tomado por `supervisor`. */
    const hastaAsignacion = async () => {
      const t = await crear();
      await avanzar(t.id, 'preparacion_herramientas').expect(201);
      await confirmarListado(t.id);
      await avanzar(t.id, 'asignacion').expect(201);
      return t;
    };

    beforeAll(async () => {
      await sembrarMaestros(admin, MAESTROS);
      Object.assign(process.env, {
        SERVICE_NAME: 'operaciones-test',
        PORT: '3197',
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
          FcrModule,
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
        .spyOn(DespachosConsumer.prototype, 'onApplicationBootstrap')
        .mockResolvedValue(undefined);
      await app.init();
      prisma = app.get(PrismaService);
      consumer = app.get(PedidosAbiertosConsumer);
    });

    afterAll(async () => {
      if (pedidos.length) {
        await admin.query('DELETE FROM fcr.ticket WHERE pedido_id = ANY($1::uuid[])', [pedidos]);
        await admin.query(
          "DELETE FROM msg_operaciones.outbox WHERE datos->'data'->>'pedidoId' = ANY($1::text[])",
          [pedidos],
        );
      }
      if (eventos.length)
        await admin.query('DELETE FROM msg_operaciones.inbox WHERE id = ANY($1::uuid[])', [
          eventos,
        ]);
      await quitarMaestros(admin, MAESTROS);
      await admin.end();
      await appPool.end();
      await app.close();
    });

    describe('creación del ticket desde el pedido abierto', () => {
      it('crea el ticket de venta con los ids del pedido (FK a los catálogos), la entrada de VENTA y el historial', async () => {
        const e = evento();
        await consumer.consumir(e);
        const t = await prisma.ticket.findUniqueOrThrow({
          where: { pedidoId: e.subject.id },
          include: { tiposServicio: true, historial: true },
        });
        expect(t.ticketNumero).toBe(e.data['ticketNumero']);
        expect(t).toMatchObject({
          pasoCodigo: 'revision_inicial',
          tipoOt: 'venta',
          pedidoCodigo: `PED-FCR${n}`,
          clienteId: CLIENTE.id,
          campoId: CAMPO.id,
          pozoId: POZO.id,
          tipoOperadorId: null,
          inspectorId: null,
          version: 1,
        });
        expect(t.fechaInicioServicio?.toISOString().slice(0, 10)).toBe('2026-11-05');
        expect(t.fechaFinServicio?.toISOString().slice(0, 10)).toBe('2026-11-12');
        expect(t.tiposServicio.map((x) => x.tipoCodigo)).toEqual(['pesca']);
        expect(t.historial).toHaveLength(1);
        expect(t.historial[0]).toMatchObject({
          pasoAnterior: null,
          pasoNuevo: 'revision_inicial',
          origen: 'sistema',
          motivo: 'Pedido abierto',
        });
        const out = await salidas(e.subject.id);
        expect(out.map((s) => s.tipo)).toEqual(['operaciones.fcr.ticket_creado']);
        expect(out[0].datos.data).toMatchObject({
          tipoOt: 'venta',
          paso: 'revision_inicial',
          cliente: CLIENTE.nombre,
          pozo: POZO.nombre,
        });
      });

      it('un pedido de servicios nace en el paso «Tipo de operador» y un pedido sin tipo de OT se trata como venta', async () => {
        const s = await crear({ tipoOt: 'servicio' });
        expect((await prisma.ticket.findUniqueOrThrow({ where: { id: s.id } })).pasoCodigo).toBe(
          'tipo_operador',
        );
        const sin = await crear({ tipoOt: null });
        const t = await prisma.ticket.findUniqueOrThrow({ where: { id: sin.id } });
        expect([t.tipoOt, t.pasoCodigo]).toEqual(['venta', 'revision_inicial']);
      });

      it('guarda quién abrió el pedido si es una cuenta real, y no falla si no lo es', async () => {
        const conActor = evento();
        conActor.actor = { userId: JEFE.id, role: 'jefe_base' };
        await consumer.consumir(conActor);
        const t = await prisma.ticket.findUniqueOrThrow({
          where: { pedidoId: conActor.subject.id },
        });
        expect(t.createdBy).toBe(JEFE.id);
        const ajeno = evento();
        ajeno.actor = { userId: uuidv7(), role: 'jefe_base' };
        await consumer.consumir(ajeno);
        expect(
          (await prisma.ticket.findUniqueOrThrow({ where: { pedidoId: ajeno.subject.id } }))
            .createdBy,
        ).toBeNull();
      });

      it('no duplica el ticket si el evento se entrega dos veces ni si llega otro evento del mismo pedido', async () => {
        const e = evento();
        await consumer.consumir(e);
        await consumer.consumir(e);
        await consumer.consumir(evento({ subject: e.subject }));
        expect(await prisma.ticket.count({ where: { pedidoId: e.subject.id } })).toBe(1);
      });

      it('ignora los pedidos de otra línea (Pumping)', async () => {
        const e = evento({ data: { lineaServicio: 'pumping' } });
        await consumer.consumir(e);
        expect(await prisma.ticket.count({ where: { pedidoId: e.subject.id } })).toBe(0);
      });

      it('genera los requisitos del ticket solo para su tipo de OT', async () => {
        const v = await crear();
        const s = await crear({ tipoOt: 'servicio' });
        const reqs = async (id: string) =>
          (await prisma.ticketRequisito.findMany({ where: { ticketId: id } })).map(
            (r) => r.requisitoCodigo,
          );
        // los del tronco aplican a los dos; el del tipo de operador, solo a SERVICIOS
        const comunes = ['herramientas_recibidas', 'listado_herramientas_confirmado'];
        expect((await reqs(v.id)).sort()).toEqual(comunes);
        expect((await reqs(s.id)).sort()).toEqual([...comunes, 'tipo_operador_definido']);
      });
    });

    describe('bandeja y permisos', () => {
      it('el Supervisor ve los tickets de los pasos de arranque; el Operador FCR no los ve como suyos', async () => {
        const t = await crear();
        const mios = await http()
          .get('/api/operaciones/fcr/tickets?mios=true')
          .set(supervisor())
          .expect(200);
        const fila = mios.body.find((x: { id: string }) => x.id === t.id);
        expect(fila).toMatchObject({
          pedidoCodigo: `PED-FCR${n}`,
          cliente: CLIENTE.nombre,
          pozo: POZO.nombre,
          taladro: null,
          tipoOt: 'venta',
          tiposServicio: ['pesca'],
          paso: { codigo: 'revision_inicial', macro: 'pendiente', roles: ['supervisor'] },
        });
        const delOperador = await http()
          .get('/api/operaciones/fcr/tickets?mios=true')
          .set(operador())
          .expect(200);
        expect(delOperador.body.find((x: { id: string }) => x.id === t.id)).toBeUndefined();
      });

      it('filtra por paso, por texto y por número de ticket', async () => {
        const t = await crear({ pozoId: POZO.id });
        const num = (await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).ticketNumero;
        const porNumero = await http()
          .get(`/api/operaciones/fcr/tickets?q=${num}`)
          .set(supervisor())
          .expect(200);
        expect(porNumero.body.map((x: { id: string }) => x.id)).toEqual([t.id]);
        const porPozo = await http()
          .get(`/api/operaciones/fcr/tickets?q=${POZO.nombre}&paso=revision_inicial`)
          .set(supervisor())
          .expect(200);
        expect(porPozo.body.map((x: { id: string }) => x.id)).toContain(t.id);
        const otroPaso = await http()
          .get(`/api/operaciones/fcr/tickets?q=${POZO.nombre}&paso=cierre`)
          .set(supervisor())
          .expect(200);
        expect(otroPaso.body).toEqual([]);
      });

      it('exige el permiso fcr.tickets.operar (sin él, 403) y el requisito del puente tiene el suyo', async () => {
        const t = await crear();
        await http().get('/api/operaciones/fcr/tickets').set(sinPermiso()).expect(403);
        await http().get(`/api/operaciones/fcr/tickets/${t.id}`).set(sinPermiso()).expect(403);
        await http()
          .post(`/api/operaciones/fcr/requisitos/${uuidv7()}/cumplir`)
          .set(supervisor())
          .send({ motivo: 'sin permiso del puente' })
          .expect(403);
      });

      it('el detalle trae el tipo de OT, los pasos siguientes, el equipo y el historial', async () => {
        const t = await crear();
        const d = await detalle(t.id);
        expect(d).toMatchObject({
          tipoOt: 'venta',
          clienteRuc: CLIENTE.ruc,
          bloque: BLOQUE.nombre,
          fechaFinServicio: '2026-11-12',
          puedeActuar: true,
          tipoOperador: null,
          inspector: null,
          asignacion: { supervisor: null, operadores: [], unidades: [] },
        });
        expect(d.siguientes.map((s: { codigo: string }) => s.codigo)).toEqual([
          'preparacion_herramientas',
        ]);
        expect(d.historial).toHaveLength(1);
        // quien no es del rol del paso lo ve pero no puede actuar
        const delOperador = await detalle(t.id, operador());
        expect(delOperador).toMatchObject({ puedeActuar: false, siguientes: [] });
      });
    });

    describe('entrada VENTA y tronco común', () => {
      it('el Supervisor pasa de la revisión inicial a la preparación de herramientas y queda como supervisor del ticket', async () => {
        const t = await crear();
        const r = await avanzar(t.id, 'preparacion_herramientas').expect(201);
        expect(r.body.paso.codigo).toBe('preparacion_herramientas');
        expect(r.body.asignacion.supervisor).toEqual({
          usuarioId: SUPERVISOR.id,
          nombre: SUPERVISOR.nombre,
        });
        const h = r.body.historial;
        expect(h[h.length - 1]).toMatchObject({
          pasoAnterior: 'revision_inicial',
          pasoNuevo: 'preparacion_herramientas',
          actor: { nombre: SUPERVISOR.nombre, rol: 'supervisor' },
          origen: 'manual',
        });
        const out = await salidas(t.pedidoId);
        expect(out.map((s) => s.tipo)).toEqual([
          'operaciones.fcr.ticket_creado',
          'operaciones.fcr.paso_cambiado',
        ]);
      });

      it('desde la preparación solo actúa el equipo: otro Supervisor ve el ticket pero no lo mueve ni lo ve en su bandeja', async () => {
        const t = await crear();
        await avanzar(t.id, 'preparacion_herramientas').expect(201);
        const r = await avanzar(t.id, 'asignacion', otroSupervisor()).expect(403);
        expect(r.body.detail ?? r.body.message).toMatch(/equipo asignado/);
        const suya = await http()
          .get('/api/operaciones/fcr/tickets?mios=true')
          .set(supervisor())
          .expect(200);
        const ajena = await http()
          .get('/api/operaciones/fcr/tickets?mios=true')
          .set(otroSupervisor())
          .expect(200);
        expect(suya.body.some((x: { id: string }) => x.id === t.id)).toBe(true);
        expect(ajena.body.some((x: { id: string }) => x.id === t.id)).toBe(false);
        // quien coordina (Jefe de Base) sí puede, sin ser del equipo, si el rol del paso lo permite; aquí el paso es del Supervisor
        await avanzar(t.id, 'asignacion', jefe()).expect(403);
      });

      it('un ticket de venta no puede entrar al recorrido de servicios ni saltarse pasos', async () => {
        const t = await crear();
        await avanzar(t.id, 'tipo_operador').expect(409);
        await avanzar(t.id, 'inspeccion').expect(409);
        await avanzar(t.id, 'asignacion').expect(409);
        await avanzar(t.id, 'no_existe').expect(409);
        expect((await detalle(t.id)).paso.codigo).toBe('revision_inicial');
      });

      it('rechaza el cambio de paso de otro rol, de otro tipo de cuenta y de una cuenta de Pumping', async () => {
        const t = await crear();
        await avanzar(t.id, 'preparacion_herramientas', operador()).expect(403);
        await avanzar(
          t.id,
          'preparacion_herramientas',
          token(
            'supervisor_pumping',
            SUPERVISOR_PUMPING.nombre,
            [P.FCR_OPERAR],
            SUPERVISOR_PUMPING.id,
          ),
        ).expect(403);
        await avanzar(t.id, 'preparacion_herramientas', sinPermiso()).expect(403);
      });
    });

    describe('entrada SERVICIOS', () => {
      const ticketServicios = () => crear({ tipoOt: 'servicio' });

      it('no sale de «Tipo de operador» sin definir el tipo y el operador que inspecciona (409 con lo que falta)', async () => {
        const t = await ticketServicios();
        const r = await avanzar(t.id, 'inspeccion').expect(409);
        expect(r.body.code).toBe('REQUISITOS_PENDIENTES');
        expect(r.body.detail ?? r.body.message).toMatch(/Tipo de operador definido/);
      });

      it('define el tipo (mecánico o soldador) y el inspector; solo una cuenta operador FCR activa puede serlo', async () => {
        const t = await ticketServicios();
        const mecanico = await prisma.tipoOperador.findUniqueOrThrow({
          where: { codigo: 'mecanico' },
        });
        const url = `/api/operaciones/fcr/tickets/${t.id}/tipo-operador`;
        // una cuenta de otro rol no repara ni inspecciona
        await http()
          .post(url)
          .set(supervisor())
          .send({ tipoOperadorId: mecanico.id, inspectorId: OPERADOR_PUMPING.id })
          .expect(400);
        await http()
          .post(url)
          .set(supervisor())
          .send({ tipoOperadorId: uuidv7(), inspectorId: INSPECTOR.id })
          .expect(400);
        await http().post(url).set(supervisor()).send({ tipoOperadorId: mecanico.id }).expect(400);
        const r = await http()
          .post(url)
          .set(supervisor())
          .send({ tipoOperadorId: mecanico.id, inspectorId: INSPECTOR.id })
          .expect(201);
        expect(r.body.tipoOperador).toMatchObject({ codigo: 'mecanico', nombre: 'Mecánico' });
        expect(r.body.inspector).toEqual({ usuarioId: INSPECTOR.id, nombre: INSPECTOR.nombre });
        const req = r.body.requisitos.find(
          (x: { codigo: string }) => x.codigo === 'tipo_operador_definido',
        );
        expect(req).toMatchObject({ estado: 'cumplido', origen: 'sistema' });
        // se puede cambiar mientras el ticket siga en el paso
        const soldador = await prisma.tipoOperador.findUniqueOrThrow({
          where: { codigo: 'soldador' },
        });
        const otra = await http()
          .post(url)
          .set(supervisor())
          .send({ tipoOperadorId: soldador.id, inspectorId: OPERADOR.id })
          .expect(201);
        expect(otra.body.tipoOperador.codigo).toBe('soldador');
        expect(otra.body.inspector.usuarioId).toBe(OPERADOR.id);
      });

      it('en un ticket de venta no se puede definir el tipo de operador', async () => {
        const t = await crear();
        const mecanico = await prisma.tipoOperador.findUniqueOrThrow({
          where: { codigo: 'mecanico' },
        });
        await http()
          .post(`/api/operaciones/fcr/tickets/${t.id}/tipo-operador`)
          .set(supervisor())
          .send({ tipoOperadorId: mecanico.id, inspectorId: INSPECTOR.id })
          .expect(409);
      });

      it('recorre tipo de operador → inspección → aprobación y entra al mismo tronco; el rechazo vuelve a la inspección con motivo', async () => {
        const t = await ticketServicios();
        const mecanico = await prisma.tipoOperador.findUniqueOrThrow({
          where: { codigo: 'mecanico' },
        });
        await http()
          .post(`/api/operaciones/fcr/tickets/${t.id}/tipo-operador`)
          .set(supervisor())
          .send({ tipoOperadorId: mecanico.id, inspectorId: INSPECTOR.id })
          .expect(201);
        const a = await avanzar(t.id, 'inspeccion').expect(201);
        expect(a.body.paso.codigo).toBe('inspeccion');
        // el supervisor tomó el ticket al sacarlo del paso de arranque
        expect(a.body.asignacion.supervisor.usuarioId).toBe(SUPERVISOR.id);

        // en la inspección actúa el operador que inspecciona; ni el Supervisor ni otro operador FCR
        await avanzar(t.id, 'aprobacion_supervisor_operaciones', supervisor()).expect(403);
        await avanzar(t.id, 'aprobacion_supervisor_operaciones', otroOperador()).expect(403);
        await avanzar(t.id, 'aprobacion_supervisor_operaciones', inspector()).expect(201);

        // la aprobación la atiende el Supervisor de Operaciones FCR (cualquiera: no requiere equipo) y ve el ticket en su bandeja
        const suya = await http()
          .get('/api/operaciones/fcr/tickets?mios=true')
          .set(supervisorOps())
          .expect(200);
        expect(suya.body.some((x: { id: string }) => x.id === t.id)).toBe(true);
        await avanzar(t.id, 'preparacion_herramientas', supervisor()).expect(403);
        // el rechazo exige motivo y vuelve a la inspección
        await avanzar(t.id, 'inspeccion', supervisorOps()).expect(400);
        const rechazo = await avanzar(
          t.id,
          'inspeccion',
          supervisorOps(),
          'Falta el torque de la sarta',
        ).expect(201);
        expect(rechazo.body.paso.codigo).toBe('inspeccion');
        await avanzar(t.id, 'aprobacion_supervisor_operaciones', inspector()).expect(201);
        const ok = await avanzar(t.id, 'preparacion_herramientas', supervisorOps()).expect(201);
        expect(ok.body.paso.codigo).toBe('preparacion_herramientas');
        // el motivo del rechazo y todo el recorrido quedan en el historial
        expect(ok.body.historial.map((h: { pasoNuevo: string }) => h.pasoNuevo)).toEqual([
          'tipo_operador',
          'inspeccion',
          'aprobacion_supervisor_operaciones',
          'inspeccion',
          'aprobacion_supervisor_operaciones',
          'preparacion_herramientas',
        ]);
        expect(
          ok.body.historial.find((h: { motivo: string | null }) => h.motivo?.includes('torque')),
        ).toBeTruthy();
        // el Supervisor de Operaciones no es del equipo: el ticket sigue siendo del Supervisor que lo tomó
        await avanzar(t.id, 'asignacion', otroSupervisor()).expect(403);
        await confirmarListado(t.id);
        await avanzar(t.id, 'asignacion', supervisor()).expect(201);
      });
    });

    describe('asignación del equipo', () => {
      const asignar = (id: string, cuerpo: Record<string, unknown>, auth = supervisor()) =>
        http().post(`/api/operaciones/fcr/tickets/${id}/asignar`).set(auth).send(cuerpo);

      it('asigna al operador (y su unidad), pasa a la reunión operativa, crea los requisitos y publica el evento con las cuentas elegidas', async () => {
        const t = await hastaAsignacion();
        const r = await asignar(t.id, {
          operadores: [
            { usuarioId: OPERADOR.id, vehiculoId: VEHICULO.id },
            { usuarioId: INSPECTOR.id },
          ],
        }).expect(201);
        expect(r.body.paso.codigo).toBe('reunion_operativa');
        expect(r.body.asignacion.supervisor.usuarioId).toBe(SUPERVISOR.id);
        expect(r.body.asignacion.operadores).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              usuarioId: OPERADOR.id,
              vehiculoId: VEHICULO.id,
              placa: VEHICULO.placa,
            }),
            expect.objectContaining({ usuarioId: INSPECTOR.id, vehiculoId: null, placa: null }),
          ]),
        );
        expect(r.body.asignacion.unidades.map((u: { placa: string }) => u.placa)).toEqual([
          VEHICULO.placa,
        ]);
        const salida = (await salidas(t.pedidoId)).find(
          (s) => s.tipo === 'operaciones.fcr.asignacion_realizada',
        );
        expect(salida?.datos.data).toMatchObject({
          ticketId: t.id,
          supervisor: SUPERVISOR.nombre,
          unidades: VEHICULO.placa,
          asignadoPor: SUPERVISOR.nombre,
        });
        expect(salida?.datos.data['asignados']).toEqual(
          expect.arrayContaining([
            { usuarioId: SUPERVISOR.id, rolCodigo: 'supervisor' },
            { usuarioId: OPERADOR.id, rolCodigo: 'operador' },
            { usuarioId: INSPECTOR.id, rolCodigo: 'operador' },
          ]),
        );
        expect(salida?.datos.data['operadoresUnidades']).toEqual(
          expect.arrayContaining([
            { usuarioId: OPERADOR.id, vehiculoId: VEHICULO.id },
            { usuarioId: INSPECTOR.id, vehiculoId: null },
          ]),
        );
      });

      it('valida el equipo: al menos un operador, sin repetidos, rol operador FCR, cuentas activas y unidades habilitadas', async () => {
        const t = await hastaAsignacion();
        await asignar(t.id, { operadores: [] }).expect(400);
        await asignar(t.id, {
          operadores: [{ usuarioId: OPERADOR.id }, { usuarioId: OPERADOR.id }],
        }).expect(400);
        // un supervisor o un operador de Pumping no son operadores de FCR
        await asignar(t.id, { operadores: [{ usuarioId: SUPERVISOR_PUMPING.id }] }).expect(400);
        await asignar(t.id, { operadores: [{ usuarioId: OPERADOR_PUMPING.id }] }).expect(400);
        await asignar(t.id, { operadores: [{ usuarioId: uuidv7() }] }).expect(400);
        await asignar(t.id, {
          operadores: [{ usuarioId: OPERADOR.id, vehiculoId: uuidv7() }],
        }).expect(400);
        // el supervisor no puede ser además operador
        await asignar(t.id, {
          supervisorId: SUPERVISOR.id,
          operadores: [{ usuarioId: SUPERVISOR.id }],
        }).expect(400);
        expect((await detalle(t.id)).paso.codigo).toBe('asignacion');
        // una asignación rechazada no deja requisitos de operador ni de unidad
        expect(
          await prisma.ticketRequisito.count({
            where: {
              ticketId: t.id,
              OR: [{ usuarioId: { not: null } }, { vehiculoId: { not: null } }],
            },
          }),
        ).toBe(0);
      });

      it('solo el equipo del ticket asigna y solo desde el paso de Asignación; el supervisor ya asignado no lo cambia otro Supervisor', async () => {
        const t = await hastaAsignacion();
        await asignar(t.id, { operadores: [{ usuarioId: OPERADOR.id }] }, otroSupervisor()).expect(
          403,
        );
        await asignar(t.id, { operadores: [{ usuarioId: OPERADOR.id }] }, operador()).expect(403);
        await asignar(
          t.id,
          { supervisorId: OTRO_SUPERVISOR.id, operadores: [{ usuarioId: OPERADOR.id }] },
          supervisor(),
        ).expect(409);
        await asignar(t.id, { operadores: [{ usuarioId: OPERADOR.id }] }).expect(201);
        // ya no está en Asignación
        await asignar(t.id, { operadores: [{ usuarioId: OTRO_OPERADOR.id }] }).expect(409);
        const otro = await crear();
        await asignar(otro.id, { operadores: [{ usuarioId: OPERADOR.id }] }).expect(409);
      });

      it('quien coordina (Jefe de Base) no puede asignar: el paso es del Supervisor', async () => {
        const t = await hastaAsignacion();
        await asignar(t.id, { operadores: [{ usuarioId: OPERADOR.id }] }, jefe()).expect(403);
      });

      it('después de asignar, en la ejecución solo actúa el operador asignado y los pasos siguientes siguen su camino', async () => {
        const t = await hastaAsignacion();
        await asignar(t.id, { operadores: [{ usuarioId: OPERADOR.id }] }).expect(201);
        // reunión operativa: la atiende el Supervisor del ticket
        await avanzar(t.id, 'ejecucion_operativa', otroSupervisor()).expect(403);
        await avanzar(t.id, 'ejecucion_operativa', supervisor()).expect(201);
        // ejecución: el rol es operador FCR y además debe ser del equipo
        await avanzar(t.id, 'revision_reportes', otroOperador()).expect(403);
        const mios = await http()
          .get('/api/operaciones/fcr/tickets?mios=true')
          .set(operador())
          .expect(200);
        expect(mios.body.some((x: { id: string }) => x.id === t.id)).toBe(true);
        const ajenos = await http()
          .get('/api/operaciones/fcr/tickets?mios=true')
          .set(otroOperador())
          .expect(200);
        expect(ajenos.body.some((x: { id: string }) => x.id === t.id)).toBe(false);
        await avanzar(t.id, 'revision_reportes', operador()).expect(201);
        // el rechazo de la revisión vuelve a la ejecución con motivo
        await avanzar(t.id, 'ejecucion_operativa', supervisor()).expect(400);
        await avanzar(
          t.id,
          'ejecucion_operativa',
          supervisor(),
          'Falta el reporte del día 2',
        ).expect(201);
        await avanzar(t.id, 'revision_reportes', operador()).expect(201);
        await avanzar(t.id, 'control_retorno', supervisor()).expect(201);
        // Bodega atiende el retorno sin ser del equipo (el paso no requiere equipo)
        const bodega = token('bodeguero', BODEGUERO.nombre, [P.FCR_OPERAR], BODEGUERO.id);
        const deBodega = await http()
          .get('/api/operaciones/fcr/tickets?mios=true')
          .set(bodega)
          .expect(200);
        expect(deBodega.body.some((x: { id: string }) => x.id === t.id)).toBe(true);
        await avanzar(t.id, 'cierre', bodega).expect(201);
        await avanzar(t.id, 'cerrado', supervisor()).expect(201);
        const out = (await salidas(t.pedidoId)).map((s) => s.tipo);
        expect(out.filter((x) => x === 'operaciones.fcr.cerrado')).toHaveLength(1);
        // cerrado: ya no hay pasos siguientes (solo lectura)
        const cerrado = await detalle(t.id);
        expect(cerrado.siguientes).toEqual([]);
        expect(cerrado.paso).toMatchObject({ codigo: 'cerrado', macro: 'aprobado' });
        await avanzar(t.id, 'cierre', supervisor()).expect(409);
      });
    });

    describe('catálogos y puente de requisitos', () => {
      it('lista los catálogos activos de FCR en orden', async () => {
        const r = await http().get('/api/operaciones/fcr/catalogos').set(supervisor()).expect(200);
        expect(r.body.tiposOperador.map((x: { codigo: string }) => x.codigo)).toEqual([
          'mecanico',
          'soldador',
        ]);
        expect(r.body.tiposCompletacion.map((x: { codigo: string }) => x.codigo)).toEqual([
          'selectiva',
          'inyeccion',
          'power_oil',
        ]);
        expect(r.body.tiposTrabajo).toHaveLength(5);
        expect(r.body.tiposPicker.map((x: { nombre: string }) => x.nombre)).toEqual([
          '7/8"',
          '9.5/8"',
          '5.5/8"',
          '5/8"',
        ]);
      });

      it('el puente temporal no confirma los requisitos que cumple FCR', async () => {
        const t = await crear({ tipoOt: 'servicio' });
        const r = (await prisma.ticketRequisito.findFirstOrThrow({ where: { ticketId: t.id } })).id;
        await http()
          .post(`/api/operaciones/fcr/requisitos/${r}/cumplir`)
          .set(jefe())
          .send({ motivo: 'prueba del puente' })
          .expect(400);
        await http()
          .post(`/api/operaciones/fcr/requisitos/${r}/cumplir`)
          .set(jefe())
          .send({ motivo: 'x' })
          .expect(400);
      });
    });

    describe('reglas de la base de datos (el servicio no es la única barrera)', () => {
      const rechaza = async (sql: string, params: unknown[], patron: RegExp, pool = admin) => {
        await expect(pool.query(sql, params)).rejects.toThrow(patron);
      };

      it('un ticket de venta no puede llevar tipo de operador ni inspector (CHECK)', async () => {
        const t = await crear();
        await rechaza(
          'UPDATE fcr.ticket SET inspector_id = $2 WHERE id = $1',
          [t.id, INSPECTOR.id],
          /ticket_servicios_check/,
        );
        const tipo = await prisma.tipoOperador.findUniqueOrThrow({ where: { codigo: 'mecanico' } });
        await rechaza(
          'UPDATE fcr.ticket SET tipo_operador_id = $2 WHERE id = $1',
          [t.id, tipo.id],
          /ticket_servicios_check/,
        );
      });

      it('las fechas del servicio, la versión, los ids de catálogo y el tipo de OT se validan', async () => {
        const t = await crear();
        await rechaza(
          "UPDATE fcr.ticket SET fecha_fin_servicio = '2020-01-01' WHERE id = $1",
          [t.id],
          /ticket_fechas_check/,
        );
        await rechaza(
          'UPDATE fcr.ticket SET version = 0 WHERE id = $1',
          [t.id],
          /ticket_version_check/,
        );
        await rechaza(
          'UPDATE fcr.ticket SET cliente_id = $2 WHERE id = $1',
          [t.id, uuidv7()],
          /ticket_cliente_fkey/,
        );
        await rechaza(
          "UPDATE fcr.ticket SET paso_codigo = 'inventado' WHERE id = $1",
          [t.id],
          /ticket_paso_fkey/,
        );
        await rechaza(
          "UPDATE fcr.ticket SET tipo_ot = 'otro' WHERE id = $1",
          [t.id],
          /invalid input value for enum/,
        );
      });

      it('un pedido tiene un solo ticket y un número de ticket no se repite', async () => {
        const t = await crear();
        const fila = await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } });
        await rechaza(
          `INSERT INTO fcr.ticket (id, pedido_id, pedido_codigo, paso_codigo, tipo_ot) VALUES ($1, $2, 'X', 'revision_inicial', 'venta')`,
          [uuidv7(), fila.pedidoId],
          /ticket_pedido_id_key/,
        );
        await rechaza(
          `INSERT INTO fcr.ticket (id, pedido_id, pedido_codigo, paso_codigo, tipo_ot, ticket_numero) VALUES ($1, $2, 'X', 'revision_inicial', 'venta', $3)`,
          [uuidv7(), uuidv7(), fila.ticketNumero],
          /ticket_ticket_numero_key/,
        );
      });

      it('el historial es inmutable: la aplicación no puede modificarlo ni borrarlo', async () => {
        const t = await crear();
        await rechaza(
          "UPDATE fcr.ticket_historial SET motivo = 'cambiado' WHERE ticket_id = $1",
          [t.id],
          /permission denied/,
          appPool,
        );
        await rechaza(
          'DELETE FROM fcr.ticket_historial WHERE ticket_id = $1',
          [t.id],
          /permission denied/,
          appPool,
        );
        // un registro nuevo sí se puede agregar
        await appPool.query(
          "INSERT INTO fcr.ticket_historial (id, ticket_id, paso_nuevo, motivo) VALUES ($1, $2, 'revision_inicial', 'nota')",
          [uuidv7(), t.id],
        );
      });

      it('el equipo: un solo supervisor, la unidad del operador debe ser del ticket y solo los operadores llevan unidad', async () => {
        const t = await crear();
        await admin.query(
          "INSERT INTO fcr.ticket_persona (ticket_id, usuario_id, rol) VALUES ($1, $2, 'supervisor')",
          [t.id, SUPERVISOR.id],
        );
        await rechaza(
          "INSERT INTO fcr.ticket_persona (ticket_id, usuario_id, rol) VALUES ($1, $2, 'supervisor')",
          [t.id, OTRO_SUPERVISOR.id],
          /ticket_persona_supervisor_key/,
        );
        // la unidad no está asignada al ticket
        await rechaza(
          "INSERT INTO fcr.ticket_persona (ticket_id, usuario_id, rol, vehiculo_id) VALUES ($1, $2, 'operador', $3)",
          [t.id, OPERADOR.id, VEHICULO_AJENO.id],
          /ticket_persona_unidad_fkey/,
        );
        await admin.query(
          'INSERT INTO fcr.ticket_unidad (ticket_id, vehiculo_id) VALUES ($1, $2)',
          [t.id, VEHICULO.id],
        );
        await rechaza(
          "INSERT INTO fcr.ticket_persona (ticket_id, usuario_id, rol, vehiculo_id) VALUES ($1, $2, 'supervisor', $3)",
          [t.id, OTRO_SUPERVISOR.id, VEHICULO.id],
          /ticket_persona_unidad_check/,
        );
        await rechaza(
          "INSERT INTO fcr.ticket_persona (ticket_id, usuario_id, rol) VALUES ($1, $2, 'operador')",
          [t.id, uuidv7()],
          /ticket_persona_usuario_fkey/,
        );
      });

      it('un requisito no se repite, no es de una unidad y un operador a la vez y el puente exige motivo', async () => {
        const t = await crear({ tipoOt: 'servicio' });
        await rechaza(
          "INSERT INTO fcr.ticket_requisito (id, ticket_id, requisito_codigo) VALUES ($1, $2, 'tipo_operador_definido')",
          [uuidv7(), t.id],
          /ticket_requisito_unico_key/,
        );
        await rechaza(
          "INSERT INTO fcr.ticket_requisito (id, ticket_id, requisito_codigo) VALUES ($1, $2, 'no_existe')",
          [uuidv7(), t.id],
          /ticket_requisito_requisito_fkey/,
        );
        await rechaza(
          "UPDATE fcr.ticket_requisito SET estado = 'cumplido' WHERE ticket_id = $1",
          [t.id],
          /ticket_requisito_cumplido_check/,
        );
        await rechaza(
          "UPDATE fcr.ticket_requisito SET estado = 'cumplido', cumplido_at = now(), origen = 'manual_temporal' WHERE ticket_id = $1",
          [t.id],
          /ticket_requisito_manual_check/,
        );
      });

      it('los pasos: roles de cuentas reales, orden único, una transición no va de un paso a sí mismo y la entrada apunta a un paso', async () => {
        await rechaza(
          "INSERT INTO fcr.paso_rol (paso_codigo, rol_codigo) VALUES ('cierre', 'rol_inventado')",
          [],
          /paso_rol_rol_fkey/,
        );
        await rechaza(
          "INSERT INTO fcr.paso (codigo, nombre, macro, orden) VALUES ('paso_x', 'X', 'pendiente', 10)",
          [],
          /paso_orden_key/,
        );
        await rechaza(
          "INSERT INTO fcr.transicion (id, origen_codigo, destino_codigo) VALUES ($1, 'cierre', 'cierre')",
          [uuidv7()],
          /transicion_distinta_check/,
        );
        await rechaza(
          "INSERT INTO fcr.transicion (id, origen_codigo, destino_codigo) VALUES ($1, 'cierre', 'cerrado')",
          [uuidv7()],
          /transicion_origen_destino_key/,
        );
        await rechaza(
          "UPDATE fcr.entrada_ot SET paso_codigo = 'inventado' WHERE tipo_ot = 'venta'",
          [],
          /entrada_ot_paso_fkey/,
        );
      });

      it('los catálogos tienen código único y la aplicación no puede borrarlos', async () => {
        await rechaza(
          "INSERT INTO fcr.tipo_picker (id, codigo, nombre, orden) VALUES ($1, '7_8', 'otro', 99)",
          [uuidv7()],
          /tipo_picker_codigo_key/,
        );
        await rechaza(
          "INSERT INTO fcr.tipo_trabajo (id, codigo, nombre, orden, created_by) VALUES ($1, 'zz', 'ZZ', 99, $2)",
          [uuidv7(), uuidv7()],
          /tipo_trabajo_created_by_fkey/,
        );
        await rechaza(
          "DELETE FROM fcr.tipo_operador WHERE codigo = 'mecanico'",
          [],
          /permission denied/,
          appPool,
        );
      });
    });
  },
);
