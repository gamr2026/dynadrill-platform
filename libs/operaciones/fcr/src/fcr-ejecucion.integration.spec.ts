/**
 * Integración real de la ejecución de FCR (F4): acta de la reunión operativa, bitácora diaria enviada día por día a Comercial,
 * corrección de Facturación, uso diario de las herramientas, finalización de la ejecución (Reporte de Herramientas) y revisión de
 * reportes. Postgres real; sin RabbitMQ.
 *   RUN_INTEGRATION=1 npx jest fcr-ejecucion
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
const u = (nombre: string, rol: string) => ({ id: uuidv7(), nombre, rol });
const SUPERVISOR = u('Sara Supervisora', 'supervisor');
const OPERADOR = u('Olga Operadora', 'operador_fcr');
const OTRO_OPERADOR = u('Omar Operador', 'operador_fcr');
const BODEGUERO = u('Bruno Bodeguero', 'bodeguero');
const VENTAS = u('Vera Ventas', 'ingenieria_ventas');
const CLIENTE = { id: uuidv7(), nombre: `Cliente EJ ${n}`, ruc: `83${String(n).slice(-11)}` };
const CAMPO = { id: uuidv7(), nombre: `SACHA EJ ${n}` };
const BLOQUE = { id: uuidv7(), nombre: `Bloque EJ ${n}` };
const POZO = { id: uuidv7(), nombre: `EJ-POZO-${n}`, campoId: CAMPO.id, bloqueId: BLOQUE.id };
const CAT = uuidv7();
const art = (s: string) => ({ id: uuidv7(), codigo: `EJ-${s}-${n}` });
const CEPILLO = art('CEP');
const MAGNETO = art('MAG');
const MAESTROS: MaestrosDePrueba = {
  usuarios: [SUPERVISOR, OPERADOR, OTRO_OPERADOR, BODEGUERO, VENTAS],
  clientes: [CLIENTE],
  campos: [CAMPO],
  bloques: [BLOQUE],
  pozos: [POZO],
};

run(
  'FCR: reunión, bitácora diaria, uso de herramientas, finalización y revisión de reportes (base de datos real)',
  () => {
    jest.setTimeout(150000);
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
    const tok = (
      x: { id: string; nombre: string; rol: string },
      permisos: string[] = [P.FCR_OPERAR, P.FCR_VER],
    ) => ({
      Authorization: `Bearer ${signer.sign({ sub: x.id, email: `${x.rol}@test.local`, name: x.nombre, roleId: 'r', roleCode: x.rol, permissions: permisos })}`,
    });
    const supervisor = () => tok(SUPERVISOR);
    const operador = () => tok(OPERADOR);
    const bodega = () => tok(BODEGUERO, [P.FCR_OPERAR, P.FCR_HERRAMIENTAS_PREPARAR]);
    const ventas = () => tok(VENTAS, [P.FCR_VER, P.FCR_CONFIGURACION_GESTIONAR]);

    const pedidos: string[] = [];
    const eventos: string[] = [];
    let seq = 400_000 + (n % 100_000) * 10;
    let cods = 0;
    const base = (t: string) => `/api/operaciones/fcr/tickets/${t}`;
    const q = (r: { body: { detail?: string; message?: string } }) =>
      String(r.body.detail ?? r.body.message);
    const salidas = async (pedidoId: string, tipo?: string) =>
      (
        await admin.query(
          "SELECT tipo, datos->'data' AS d FROM msg_operaciones.outbox WHERE datos->'data'->>'pedidoId' = $1 ORDER BY ocurrido_at, id",
          [pedidoId],
        )
      ).rows.filter((r: { tipo: string }) => !tipo || r.tipo === tipo) as Array<{
        tipo: string;
        d: Record<string, unknown>;
      }>;

    const evento = (tipo: string, pedidoId: string, data: Record<string, unknown>) => {
      if (!pedidos.includes(pedidoId)) pedidos.push(pedidoId);
      const id = uuidv7();
      eventos.push(id);
      return {
        id,
        type: tipo,
        version: 1,
        occurredAt: '2026-11-02T10:00:00.000Z',
        source: 'comercial',
        subject: { type: 'pedido', id: pedidoId },
        data,
      } as EventEnvelope;
    };

    /** Ticket de venta en la ejecución, con un cepillo y un magneto recibidos, asignado al operador, con el acta confirmada. */
    const enEjecucion = async (fechas = { inicio: '2026-11-05', fin: '2026-11-12' }) => {
      const codigo = `SH-EJ-${n}-${cods++}`;
      await http()
        .put('/api/operaciones/fcr/configuracion-codigos')
        .set(ventas())
        .send({
          clienteId: CLIENTE.id,
          codigo,
          clasificacion: 'herramienta',
          kit: [
            { articuloId: CEPILLO.id, cantidad: 1 },
            { articuloId: MAGNETO.id, cantidad: 1 },
          ],
        })
        .expect(200);
      const e = evento('comercial.pedido.abierto', uuidv7(), {
        codigo: `PED-EJ${n}`,
        lineaServicio: 'fcr',
        tipoOt: 'venta',
        tiposServicio: ['pesca'],
        ticketNumero: seq++,
        clienteId: CLIENTE.id,
        campoId: CAMPO.id,
        bloqueId: BLOQUE.id,
        pozoId: POZO.id,
        rigless: false,
        fechaInicioServicio: fechas.inicio,
        fechaFinServicio: fechas.fin,
        lineas: [
          {
            codigo,
            descripcion: 'Sarta',
            unidad: 'Corrida',
            cantidad: 1,
            tipoLinea: 'herramienta',
          },
        ],
      });
      await consumer.consumir(e);
      const t = await prisma.ticket.findUniqueOrThrow({ where: { pedidoId: e.subject.id } });
      const id = t.id;
      await http()
        .post(`${base(id)}/avanzar`)
        .set(supervisor())
        .send({ hacia: 'preparacion_herramientas' })
        .expect(201);
      await http()
        .post(`${base(id)}/herramientas/solicitar`)
        .set(supervisor())
        .send({})
        .expect(201);
      const lista = (
        await http()
          .get(`${base(id)}/herramientas`)
          .set(supervisor())
          .expect(200)
      ).body;
      for (const h of lista.herramientas) {
        await http()
          .post(`${base(id)}/herramientas/${h.id}/preparar`)
          .set(bodega())
          .send({})
          .expect(201);
        await http()
          .post(`${base(id)}/herramientas/${h.id}/enviar`)
          .set(bodega())
          .expect(201);
        await http()
          .post(`${base(id)}/herramientas/${h.id}/recibir`)
          .set(supervisor())
          .send({})
          .expect(201);
      }
      await http()
        .post(`${base(id)}/herramientas/confirmar-listado`)
        .set(supervisor())
        .send({ confirmado: true })
        .expect(201);
      await http()
        .post(`${base(id)}/avanzar`)
        .set(supervisor())
        .send({ hacia: 'asignacion' })
        .expect(201);
      await http()
        .post(`${base(id)}/asignar`)
        .set(supervisor())
        .send({ operadores: [{ usuarioId: OPERADOR.id }] })
        .expect(201);
      await http()
        .put(`${base(id)}/reunion-operativa`)
        .set(supervisor())
        .send({ fecha: fechas.inicio })
        .expect(200);
      await http()
        .post(`${base(id)}/avanzar`)
        .set(supervisor())
        .send({ hacia: 'ejecucion_operativa' })
        .expect(201);
      return {
        id,
        pedidoId: e.subject.id,
        cepillo: lista.herramientas.find((h: { articuloId: string }) => h.articuloId === CEPILLO.id)
          .id as string,
        magneto: lista.herramientas.find((h: { articuloId: string }) => h.articuloId === MAGNETO.id)
          .id as string,
      };
    };
    const act = (horaInicio = '08:00', horaFin = '10:30', detalle = 'Bajada de la sarta') => ({
      horaInicio,
      horaFin,
      detalle,
    });
    const guardar = (t: string, fecha: string, actividades = [act()], auth = operador()) =>
      http()
        .put(`${base(t)}/bitacora/${fecha}`)
        .set(auth)
        .send({ actividades });
    const enviar = (t: string, fecha: string, auth = operador()) =>
      http()
        .post(`${base(t)}/bitacora/${fecha}/enviar`)
        .set(auth);
    const uso = (
      t: string,
      h: string,
      fecha: string,
      cuerpo: Record<string, unknown> = { estado: 'operacion' },
      auth = operador(),
    ) =>
      http()
        .put(`${base(t)}/uso-herramientas/${h}/${fecha}`)
        .set(auth)
        .send(cuerpo);
    const confirmarUso = (t: string, confirmado = true) =>
      http()
        .post(`${base(t)}/uso-herramientas/confirmar-listado`)
        .set(operador())
        .send({ confirmado });
    const finalizar = (t: string, auth = operador()) =>
      http()
        .post(`${base(t)}/finalizar-ejecucion`)
        .set(auth);

    beforeAll(async () => {
      await sembrarMaestros(admin, MAESTROS);
      await admin.query(
        'INSERT INTO inventario.categoria_articulo (id, nombre, lleva_partes) VALUES ($1, $2, true)',
        [CAT, `CAT-HERR-EJ ${n}`],
      );
      for (const a of [CEPILLO, MAGNETO]) {
        await admin.query(
          `INSERT INTO inventario.articulo (id, codigo, nombre, categoria_id, unidad_stock_id) VALUES ($1, $2, $3, $4, (SELECT id FROM inventario.unidad_stock ORDER BY nombre LIMIT 1))`,
          [a.id, a.codigo, `Herramienta ${a.codigo}`, CAT],
        );
      }
      Object.assign(process.env, {
        SERVICE_NAME: 'operaciones-test',
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
      const h =
        '(SELECT id FROM fcr.ticket_herramienta WHERE ticket_id IN (SELECT id FROM fcr.ticket WHERE pedido_id = ANY($1::uuid[])))';
      if (pedidos.length) {
        await admin.query(
          `DELETE FROM fcr.ticket_herramienta_evento WHERE herramienta_id IN ${h}`,
          [pedidos],
        );
        await admin.query('DELETE FROM fcr.ticket WHERE pedido_id = ANY($1::uuid[])', [pedidos]);
        await admin.query(
          "DELETE FROM msg_operaciones.outbox WHERE datos->'data'->>'pedidoId' = ANY($1::text[])",
          [pedidos],
        );
      }
      await admin.query('DELETE FROM fcr.configuracion_codigo WHERE cliente_id = $1', [CLIENTE.id]);
      if (eventos.length)
        await admin.query('DELETE FROM msg_operaciones.inbox WHERE id = ANY($1::uuid[])', [
          eventos,
        ]);
      await admin.query('DELETE FROM inventario.articulo WHERE categoria_id = $1', [CAT]);
      await admin.query('DELETE FROM inventario.categoria_articulo WHERE id = $1', [CAT]);
      await quitarMaestros(admin, MAESTROS);
      await admin.end();
      await appPool.end();
      await app.close();
    });

    describe('acta de la reunión operativa', () => {
      it('la confirma el Supervisor del ticket con su fecha, se puede corregir en el paso y sin ella no se sale', async () => {
        const t = await enEjecucion();
        // ya en ejecución el acta quedó confirmada y no se cambia
        const a = (
          await http()
            .get(`${base(t.id)}/reunion-operativa`)
            .set(supervisor())
            .expect(200)
        ).body;
        expect(a).toMatchObject({ fecha: '2026-11-05', firmadaPor: SUPERVISOR.nombre });
        await http()
          .put(`${base(t.id)}/reunion-operativa`)
          .set(supervisor())
          .send({ fecha: '2026-11-06' })
          .expect(409);
      });
    });

    describe('bitácora diaria', () => {
      it('el operador guarda y envía cada día a Facturación; el evento lleva el Reporte Job con la forma del de Pumping', async () => {
        const t = await enEjecucion();
        const g = await guardar(t.id, '2026-11-05', [
          act('08:00', '10:30'),
          act('22:00', '02:00', 'Turno de noche'),
        ]).expect(200);
        expect(g.body).toMatchObject({ fecha: '2026-11-05', estado: 'borrador', totalHoras: 6.5 });
        expect(g.body.actividades.map((a: { duracionHoras: number }) => a.duracionHoras)).toEqual([
          2.5, 4,
        ]);
        expect(await salidas(t.pedidoId, 'operaciones.fcr.bitacora_enviada')).toHaveLength(0);
        const e = await enviar(t.id, '2026-11-05').expect(201);
        expect(e.body).toMatchObject({ estado: 'enviado' });
        const ev = await salidas(t.pedidoId, 'operaciones.fcr.bitacora_enviada');
        expect(ev).toHaveLength(1);
        expect(ev[0].d).toMatchObject({
          ticketId: t.id,
          pedidoId: t.pedidoId,
          fecha: '2026-11-05',
          firmadoPor: OPERADOR.nombre,
          supervisorId: SUPERVISOR.id,
          operadorId: OPERADOR.id,
        });
        expect(ev[0].d['actividades']).toEqual([
          expect.objectContaining({
            fecha: '2026-11-05',
            horaInicio: '08:00',
            horaFin: '10:30',
            duracionHoras: 2.5,
            detalle: 'Bajada de la sarta',
            autor: OPERADOR.nombre,
            tablas: [],
          }),
          expect.objectContaining({ horaInicio: '22:00', horaFin: '02:00', duracionHoras: 4 }),
        ]);
        // el listado trae el estado de cada día y el rango del servicio
        const l = (
          await http()
            .get(`${base(t.id)}/bitacora`)
            .set(operador())
            .expect(200)
        ).body;
        expect(l.servicio).toEqual({ desde: '2026-11-05', hasta: '2026-11-12' });
        expect(l.dias).toEqual([
          expect.objectContaining({
            fecha: '2026-11-05',
            estado: 'enviado',
            actividades: 2,
            totalHoras: 6.5,
          }),
        ]);
        // quien no es del equipo, ni el Supervisor, no escribe en la bitácora
        await guardar(t.id, '2026-11-06', [act()], tok(OTRO_OPERADOR)).expect(403);
        await guardar(t.id, '2026-11-06', [act()], supervisor()).expect(403);
        await http()
          .get(`${base(t.id)}/bitacora/2026-11-09`)
          .set(operador())
          .expect(404);
      });

      it('un día enviado que se corrige se reenvía solo; no puede quedar vacío; enviar dos veces no duplica el día', async () => {
        const t = await enEjecucion();
        await guardar(t.id, '2026-11-06').expect(200);
        await enviar(t.id, '2026-11-06').expect(201);
        await enviar(t.id, '2026-11-06').expect(201);
        expect(await prisma.bitacoraDia.count({ where: { ticketId: t.id } })).toBe(1);
        const g = await guardar(t.id, '2026-11-06', [
          act('09:00', '11:00', 'Corregido'),
          act('13:00', '14:00', 'Otra'),
        ]).expect(200);
        expect(g.body.estado).toBe('enviado');
        const ev = await salidas(t.pedidoId, 'operaciones.fcr.bitacora_enviada');
        expect(ev).toHaveLength(3); // dos envíos y el reenvío automático
        expect((ev[2].d['actividades'] as unknown[]).length).toBe(2);
        const vacio = await guardar(t.id, '2026-11-06', []).expect(409);
        expect(vacio.body.code).toBe('DIA_ENVIADO_SIN_ACTIVIDADES');
      });

      it('valida horas, detalle, fechas reales y que el día esté dentro de las fechas del servicio del pedido', async () => {
        const t = await enEjecucion();
        await guardar(t.id, '2026-11-05', [act('25:00', '10:00')]).expect(400);
        await guardar(t.id, '2026-11-05', [act('08:00', '08:00')]).expect(400);
        await guardar(t.id, '2026-11-05', [act('08:00', '09:00', '   ')]).expect(400);
        await guardar(t.id, '2026-02-31').expect(400);
        const antes = await guardar(t.id, '2026-11-04').expect(400);
        expect(antes.body.code).toBe('FUERA_DEL_SERVICIO');
        await guardar(t.id, '2026-11-13').expect(400);
        await guardar(t.id, '2026-11-12').expect(200); // el último día del servicio sí
        await enviar(t.id, '2026-11-07').expect(404); // no guardado
        await guardar(t.id, '2026-11-07', []).expect(200);
        const sin = await enviar(t.id, '2026-11-07').expect(400);
        expect(sin.body.code).toBe('SIN_ACTIVIDADES');
      });

      it('lo que Facturación corrigió ya no se edita ni se reenvía desde el ticket; el de otro origen no cuenta', async () => {
        const t = await enEjecucion();
        await guardar(t.id, '2026-11-08').expect(200);
        await enviar(t.id, '2026-11-08').expect(201);
        // un evento de Pumping con la misma fecha no es de este módulo
        await consumer.consumir(
          evento('comercial.documento_operativo.corregido', t.pedidoId, {
            pedidoId: t.pedidoId,
            origen: 'pumping',
            fecha: '2026-11-08',
          }),
        );
        await guardar(t.id, '2026-11-08', [act('07:00', '08:00', 'Aún editable')]).expect(200);
        await consumer.consumir(
          evento('comercial.documento_operativo.corregido', t.pedidoId, {
            pedidoId: t.pedidoId,
            origen: 'fcr',
            fecha: '2026-11-08',
          }),
        );
        const bloqueado = await guardar(t.id, '2026-11-08').expect(409);
        expect(bloqueado.body.code).toBe('DIA_CORREGIDO');
        expect((await enviar(t.id, '2026-11-08').expect(409)).body.code).toBe('DIA_CORREGIDO');
        expect(
          (
            await http()
              .get(`${base(t.id)}/bitacora/2026-11-08`)
              .set(operador())
              .expect(200)
          ).body.estado,
        ).toBe('corregido');
        // un día sin bitácora que Facturación creó queda marcado como corregido
        await consumer.consumir(
          evento('comercial.documento_operativo.corregido', t.pedidoId, {
            pedidoId: t.pedidoId,
            origen: 'fcr',
            fecha: '2026-11-10',
          }),
        );
        expect((await guardar(t.id, '2026-11-10').expect(409)).body.code).toBe('DIA_CORREGIDO');
        // un día fuera del servicio no se registra, sin error
        await consumer.consumir(
          evento('comercial.documento_operativo.corregido', t.pedidoId, {
            pedidoId: t.pedidoId,
            origen: 'fcr',
            fecha: '2027-01-01',
          }),
        );
        expect(await prisma.bitacoraDia.count({ where: { ticketId: t.id } })).toBe(2);
      });
    });

    describe('uso diario de las herramientas', () => {
      it('registra el estado de cobro por herramienta y día, reemplaza el mismo día y respeta las fechas del servicio', async () => {
        const t = await enEjecucion();
        const r = await uso(t.id, t.cepillo, '2026-11-05', { estado: 'operacion' }).expect(200);
        expect(r.body.usos).toEqual([
          expect.objectContaining({
            herramientaId: t.cepillo,
            fecha: '2026-11-05',
            estado: 'operacion',
            codigo: CEPILLO.codigo,
          }),
        ]);
        const otra = await uso(t.id, t.cepillo, '2026-11-05', { estado: 'stand_by' }).expect(200);
        expect(otra.body.usos).toHaveLength(1);
        expect(otra.body.usos[0].estado).toBe('stand_by');
        await uso(t.id, t.cepillo, '2026-11-06', { estado: 'daily_charge' }).expect(200);
        await uso(t.id, t.magneto, '2026-11-06', { estado: 'venta' }).expect(200);
        await uso(t.id, t.cepillo, '2026-11-20').expect(400);
        await uso(t.id, t.cepillo, '2026-11-05', { estado: 'regalado' }).expect(400);
        await uso(t.id, uuidv7(), '2026-11-05').expect(404);
        await uso(t.id, t.cepillo, '2026-11-05', undefined, tok(OTRO_OPERADOR)).expect(403);
        expect(
          (
            await http()
              .get(`${base(t.id)}/uso-herramientas`)
              .set(operador())
              .expect(200)
          ).body.usos,
        ).toHaveLength(3);
        // quitar un registro
        const id = otra.body.usos[0].id;
        const q2 = await http()
          .delete(`${base(t.id)}/uso-herramientas/${id}`)
          .set(operador())
          .expect(200);
        expect(q2.body.usos).toHaveLength(2);
        await http()
          .delete(`${base(t.id)}/uso-herramientas/${id}`)
          .set(operador())
          .expect(404);
      });

      it('el registro de picker pide completación en venta o tipo de trabajo en servicios, con picker, presión y peso', async () => {
        const t = await enEjecucion();
        const cat = (await http().get('/api/operaciones/fcr/catalogos').set(operador()).expect(200))
          .body;
        const comp = cat.tiposCompletacion[0].id;
        const trab = cat.tiposTrabajo[0].id;
        const pick = cat.tiposPicker[0].id;
        const cuerpo = (picker: Record<string, unknown>) => ({ estado: 'operacion', picker });
        // venta
        await uso(
          t.id,
          t.cepillo,
          '2026-11-05',
          cuerpo({ tipoPickerId: pick, presion: 100, peso: 5 }),
        ).expect(400); // falta la completación
        await uso(
          t.id,
          t.cepillo,
          '2026-11-05',
          cuerpo({ tipoTrabajoId: trab, tipoPickerId: pick, presion: 100, peso: 5 }),
        ).expect(400); // trabajo en venta
        await uso(
          t.id,
          t.cepillo,
          '2026-11-05',
          cuerpo({ tipoCompletacionId: comp, tipoPickerId: pick, presion: -1, peso: 5 }),
        ).expect(400);
        await uso(
          t.id,
          t.cepillo,
          '2026-11-05',
          cuerpo({ tipoCompletacionId: uuidv7(), tipoPickerId: pick, presion: 1, peso: 5 }),
        ).expect(400);
        const ok = await uso(
          t.id,
          t.cepillo,
          '2026-11-05',
          cuerpo({
            tipoCompletacionId: comp,
            tipoPickerId: pick,
            presion: 1500.5,
            peso: 12,
            observacion: 'Atascamiento leve',
          }),
        ).expect(200);
        expect(ok.body.usos[0]).toMatchObject({
          tipoCompletacion: cat.tiposCompletacion[0].nombre,
          tipoPicker: cat.tiposPicker[0].nombre,
          presion: 1500.5,
          peso: 12,
          observacion: 'Atascamiento leve',
          tipoTrabajo: null,
        });
        // servicios: el mismo ticket pasa a ser de servicios solo para probar la regla contraria
        await admin.query("UPDATE fcr.ticket SET tipo_ot = 'servicio' WHERE id = $1", [t.id]);
        await uso(
          t.id,
          t.cepillo,
          '2026-11-06',
          cuerpo({ tipoCompletacionId: comp, tipoPickerId: pick, presion: 1, peso: 1 }),
        ).expect(400);
        await uso(
          t.id,
          t.cepillo,
          '2026-11-06',
          cuerpo({ tipoPickerId: pick, presion: 1, peso: 1 }),
        ).expect(400); // falta el trabajo
        const s = await uso(
          t.id,
          t.cepillo,
          '2026-11-06',
          cuerpo({ tipoTrabajoId: trab, tipoPickerId: pick, presion: 1, peso: 1 }),
        ).expect(200);
        expect(
          s.body.usos.find((x: { fecha: string }) => x.fecha === '2026-11-06').tipoTrabajo,
        ).toBe(cat.tiposTrabajo[0].nombre);
        // volver a registrar sin picker lo limpia
        const sin = await uso(t.id, t.cepillo, '2026-11-06', { estado: 'operacion' }).expect(200);
        expect(
          sin.body.usos.find((x: { fecha: string }) => x.fecha === '2026-11-06'),
        ).toMatchObject({ tipoTrabajo: null, tipoPicker: null, presion: null });
      });

      it('cualquier cambio del listado de uso obliga a confirmarlo de nuevo', async () => {
        const t = await enEjecucion();
        const c = await confirmarUso(t.id).expect(201);
        expect(c.body.listadoConfirmado).toBe(true);
        const r = await uso(t.id, t.cepillo, '2026-11-05').expect(200);
        expect(r.body.listadoConfirmado).toBe(false);
        await confirmarUso(t.id).expect(201);
        const q2 = await http()
          .delete(`${base(t.id)}/uso-herramientas/${r.body.usos[0].id}`)
          .set(operador())
          .expect(200);
        expect(q2.body.listadoConfirmado).toBe(false);
        await confirmarUso(t.id, false).expect(201);
      });
    });

    describe('finalizar la ejecución y revisar los reportes', () => {
      it('no finaliza sin bitácora enviada ni listado de uso confirmado, ni con días por enviar', async () => {
        const t = await enEjecucion();
        const falta = await finalizar(t.id).expect(409);
        expect(q(falta)).toMatch(/Bitácora enviada a Facturación/);
        await guardar(t.id, '2026-11-05').expect(200);
        expect((await finalizar(t.id).expect(409)).body.code).toBe('BITACORA_SIN_ENVIAR');
        await enviar(t.id, '2026-11-05').expect(201);
        const sinListado = await finalizar(t.id).expect(409);
        expect(q(sinListado)).toMatch(/Listado de uso de herramientas confirmado/);
        expect(q(sinListado)).not.toMatch(/Bitácora enviada/);
        await finalizar(t.id, supervisor()).expect(403);
        await finalizar(t.id, tok(OTRO_OPERADOR)).expect(403);
      });

      it('finaliza: envía el Reporte de Herramientas con el uso diario, pasa a la revisión y el operador ya no corrige', async () => {
        const t = await enEjecucion();
        await guardar(t.id, '2026-11-05').expect(200);
        await enviar(t.id, '2026-11-05').expect(201);
        await uso(t.id, t.cepillo, '2026-11-05', { estado: 'operacion' }).expect(200);
        await uso(t.id, t.cepillo, '2026-11-06', { estado: 'stand_by' }).expect(200);
        await prisma.ticketHerramienta.update({
          where: { id: t.cepillo },
          data: { numeroSerie: 'SN-1' },
        });
        await confirmarUso(t.id).expect(201);
        const r = await finalizar(t.id).expect(201);
        expect(r.body.paso.codigo).toBe('revision_reportes');
        const ev = await salidas(t.pedidoId, 'operaciones.fcr.reporte_herramientas_completado');
        expect(ev).toHaveLength(1);
        expect(ev[0].d).toMatchObject({
          ticketId: t.id,
          firmadoPor: OPERADOR.nombre,
          supervisorId: SUPERVISOR.id,
          operadorId: OPERADOR.id,
        });
        // solo la herramienta con uso; con el código de la línea del pedido (con él se factura)
        expect(ev[0].d['herramientas']).toEqual([
          {
            nombre: `Herramienta ${CEPILLO.codigo}`,
            serie: 'SN-1',
            codigo: expect.stringMatching(/^SH-EJ-/),
            usos: [
              { fecha: '2026-11-05', estado: 'operacion' },
              { fecha: '2026-11-06', estado: 'stand_by' },
            ],
          },
        ]);
        // el operador ya no corrige
        await guardar(t.id, '2026-11-06').expect(409);
        await uso(t.id, t.cepillo, '2026-11-07').expect(409);
        await finalizar(t.id).expect(409);
        // finalizar es una acción propia: el avance genérico no lo ofrece
        expect(
          (
            await http()
              .get(`${base(t.id)}`)
              .set(supervisor())
              .expect(200)
          ).body.siguientes,
        ).toEqual([]);
      });

      it('el Supervisor aprueba (control de retorno) o rechaza con motivo (vuelve a la ejecución y se reconfirma el uso)', async () => {
        const t = await enEjecucion();
        await guardar(t.id, '2026-11-05').expect(200);
        await enviar(t.id, '2026-11-05').expect(201);
        await confirmarUso(t.id).expect(201);
        await finalizar(t.id).expect(201);
        await http()
          .post(`${base(t.id)}/aprobar-reportes`)
          .set(operador())
          .expect(403);
        await http()
          .post(`${base(t.id)}/rechazar-reportes`)
          .set(supervisor())
          .send({ motivo: 'x' })
          .expect(400);
        const r = await http()
          .post(`${base(t.id)}/rechazar-reportes`)
          .set(supervisor())
          .send({ motivo: 'Falta el día 2' })
          .expect(201);
        expect(r.body.paso.codigo).toBe('ejecucion_operativa');
        expect(r.body.historial[r.body.historial.length - 1]).toMatchObject({
          pasoNuevo: 'ejecucion_operativa',
          motivo: 'Falta el día 2',
        });
        // vuelve a poder corregir; el listado de uso se debe confirmar otra vez
        await guardar(t.id, '2026-11-06').expect(200);
        await enviar(t.id, '2026-11-06').expect(201);
        expect(q(await finalizar(t.id).expect(409))).toMatch(
          /Listado de uso de herramientas confirmado/,
        );
        await confirmarUso(t.id).expect(201);
        await finalizar(t.id).expect(201);
        const ap = await http()
          .post(`${base(t.id)}/aprobar-reportes`)
          .set(supervisor())
          .expect(201);
        expect(ap.body.paso.codigo).toBe('control_retorno');
        await http()
          .post(`${base(t.id)}/aprobar-reportes`)
          .set(supervisor())
          .expect(409);
        // los dos Reportes de Herramientas (cada finalización) llegaron a Comercial
        expect(
          await salidas(t.pedidoId, 'operaciones.fcr.reporte_herramientas_completado'),
        ).toHaveLength(2);
      });
    });

    describe('reglas de la base de datos de la ejecución', () => {
      const rechaza = (sql: string, params: unknown[], patron: RegExp, pool = admin) =>
        expect(pool.query(sql, params)).rejects.toThrow(patron);

      it('la bitácora: un día por ticket, dentro del servicio, actividades con horas y detalle válidos', async () => {
        const t = await enEjecucion();
        const dia = uuidv7();
        await admin.query(
          "INSERT INTO fcr.bitacora_dia (id, ticket_id, fecha, created_by, updated_by) VALUES ($1, $2, '2026-11-09', $3, $3)",
          [dia, t.id, OPERADOR.id],
        );
        await rechaza(
          "INSERT INTO fcr.bitacora_dia (id, ticket_id, fecha, created_by, updated_by) VALUES ($1, $2, '2026-11-09', $3, $3)",
          [uuidv7(), t.id, OPERADOR.id],
          /bitacora_dia_ticket_fecha_key/,
        );
        await rechaza(
          "INSERT INTO fcr.bitacora_dia (id, ticket_id, fecha, created_by, updated_by) VALUES ($1, $2, '2026-12-25', $3, $3)",
          [uuidv7(), t.id, OPERADOR.id],
          /fuera de las fechas del servicio/,
        );
        await rechaza(
          "INSERT INTO fcr.bitacora_dia (id, ticket_id, fecha, enviada_at, created_by, updated_by) VALUES ($1, $2, '2026-11-10', now(), $3, $3)",
          [uuidv7(), t.id, OPERADOR.id],
          /bitacora_dia_enviada_check/,
        );
        const ins = (ini: string, fin: string, det: string) =>
          admin.query(
            'INSERT INTO fcr.bitacora_actividad (id, bitacora_dia_id, orden, hora_inicio, hora_fin, detalle, autor_id) VALUES ($1, $2, $3, $4, $5, $6, $7)',
            [uuidv7(), dia, Math.floor(Math.random() * 1e6), ini, fin, det, OPERADOR.id],
          );
        await expect(ins('08:00', '08:00', 'x')).rejects.toThrow(/bitacora_actividad_horas_check/);
        await expect(ins('08:00', '09:00', '  ')).rejects.toThrow(
          /bitacora_actividad_detalle_check/,
        );
      });

      it('el uso: una fila por herramienta y día, completación o trabajo (no ambos), medidas no negativas y dentro del servicio', async () => {
        const t = await enEjecucion();
        const ids = (await admin.query('SELECT id FROM fcr.tipo_completacion LIMIT 1')).rows[0].id;
        const tr = (await admin.query('SELECT id FROM fcr.tipo_trabajo LIMIT 1')).rows[0].id;
        const ins = (extra: string, vals: unknown[], fecha = '2026-11-05') =>
          admin.query(
            `INSERT INTO fcr.uso_herramienta_dia (id, herramienta_id, fecha, estado, created_by, updated_by${extra ? ', ' + extra.split('=')[0] : ''}) VALUES ($1, $2, '${fecha}', 'operacion', $3, $3${extra ? ', ' + extra.split('=')[1] : ''})`,
            [uuidv7(), t.magneto, OPERADOR.id, ...vals],
          );
        await ins('', []);
        await expect(ins('', [])).rejects.toThrow(/uso_herramienta_dia_key/);
        await expect(
          admin.query(
            "INSERT INTO fcr.uso_herramienta_dia (id, herramienta_id, fecha, estado, tipo_completacion_id, tipo_trabajo_id, created_by, updated_by) VALUES ($1, $2, '2026-11-06', 'operacion', $3, $4, $5, $5)",
            [uuidv7(), t.magneto, ids, tr, OPERADOR.id],
          ),
        ).rejects.toThrow(/uso_herramienta_dia_tipo_check/);
        await expect(
          admin.query(
            "INSERT INTO fcr.uso_herramienta_dia (id, herramienta_id, fecha, estado, presion, created_by, updated_by) VALUES ($1, $2, '2026-11-07', 'operacion', -5, $3, $3)",
            [uuidv7(), t.magneto, OPERADOR.id],
          ),
        ).rejects.toThrow(/uso_herramienta_dia_medidas_check/);
        await expect(ins('', [], '2026-12-30')).rejects.toThrow(/fuera de las fechas del servicio/);
        await rechaza(
          "INSERT INTO fcr.uso_herramienta_dia (id, herramienta_id, fecha, estado, created_by, updated_by) VALUES ($1, $2, '2026-11-08', 'regalado', $3, $3)",
          [uuidv7(), t.magneto, OPERADOR.id],
          /invalid input value for enum/,
        );
      });

      it('el acta es una por ticket y los requisitos de la ejecución están en el catálogo', async () => {
        const t = await enEjecucion();
        await rechaza(
          "INSERT INTO fcr.reunion_operativa (ticket_id, fecha, firmada_por) VALUES ($1, '2026-11-05', $2)",
          [t.id, SUPERVISOR.id],
          /reunion_operativa_pkey/,
        );
        const r = await admin.query(
          "SELECT r.codigo, pr.paso_codigo FROM fcr.requisito r JOIN fcr.paso_requisito pr ON pr.requisito_codigo = r.codigo WHERE r.codigo IN ('acta_reunion_operativa','bitacora_enviada','listado_uso_confirmado') ORDER BY 1",
        );
        expect(r.rows).toEqual([
          { codigo: 'acta_reunion_operativa', paso_codigo: 'reunion_operativa' },
          { codigo: 'bitacora_enviada', paso_codigo: 'ejecucion_operativa' },
          { codigo: 'listado_uso_confirmado', paso_codigo: 'ejecucion_operativa' },
        ]);
        await rechaza(
          "UPDATE fcr.ticket SET paso_codigo = 'control_retorno' WHERE id = $1",
          [t.id],
          /no puede pasar de/,
        );
      });
    });
  },
);
