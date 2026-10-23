/**
 * Integración real del retorno y el cierre de FCR (F5): control de retorno de herramientas, Acta de
 * Entrega de Locación y cierre con su evento. Postgres real; sin RabbitMQ.
 *   RUN_INTEGRATION=1 npx jest fcr-cierre
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
import { ActaEntregaConsumer } from './consumers/acta-entrega.consumer';
import { ResultadoCambioItemsConsumer } from './consumers/resultado-cambio-items.consumer';
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
const JEFE = u('Jaime Jefe de Base', 'jefe_base');
const CLIENTE = { id: uuidv7(), nombre: `Cliente EJ ${n}`, ruc: `83${String(n).slice(-11)}` };
const CAMPO = { id: uuidv7(), nombre: `SACHA EJ ${n}` };
const BLOQUE = { id: uuidv7(), nombre: `Bloque EJ ${n}` };
const POZO = { id: uuidv7(), nombre: `EJ-POZO-${n}`, campoId: CAMPO.id, bloqueId: BLOQUE.id };
const CAT = uuidv7();
const art = (s: string) => ({ id: uuidv7(), codigo: `EJ-${s}-${n}` });
const CEPILLO = art('CEP');
const MAGNETO = art('MAG');
const MAESTROS: MaestrosDePrueba = {
  usuarios: [SUPERVISOR, OPERADOR, OTRO_OPERADOR, BODEGUERO, VENTAS, JEFE],
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
    let actaConsumer: ActaEntregaConsumer;
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
    /** Al cerrar se pide el correo del cliente (a él va la encuesta de satisfacción): por defecto uno de prueba. */
    const avanzar = (
      id: string,
      hacia: string,
      auth = supervisor(),
      motivo?: string,
      correoCliente: string | undefined = hacia === 'cerrado' ? 'cliente@empresa.test' : undefined,
    ) =>
      http()
        .post(`${base(id)}/avanzar`)
        .set(auth)
        .send({
          hacia,
          ...(motivo ? { motivo } : {}),
          ...(correoCliente !== undefined ? { correoCliente } : {}),
        });
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
    /** Quita al operador de los demás tickets de la prueba (datos de esta suite), para que la asignación no lo vea ocupado. */
    const liberarOperador = (ticketId: string) =>
      admin.query('DELETE FROM fcr.ticket_persona WHERE usuario_id = $1 AND ticket_id <> $2', [
        OPERADOR.id,
        ticketId,
      ]);
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
          // lo cotizado del ítem que el reporte de estas pruebas marca (el reporte no puede superar lo cotizado)
          {
            codigo: `SFS-EJ-${n}`,
            descripcion: 'Ítem de prueba',
            unidad: 'día',
            cantidad: 10,
            tipoLinea: 'servicio',
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
      // cada prueba arma su ticket con las mismas fechas: el equipo de los tickets anteriores de la prueba ya terminó su servicio
      await liberarOperador(id);
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
      // el reporte de herramientas (por ítem de la lista de precios) con una fila por día marcada: lo mínimo para poder confirmarlo
      const fila = await http()
        .post(`${base(id)}/reporte-herramientas/items`)
        .set(operador())
        .send({
          listaPreciosItemId: uuidv7(),
          codigo: `SFS-EJ-${n}`,
          descripcion: 'Ítem de prueba',
          unidad: 'día',
        })
        .expect(201);
      await http()
        .put(
          `${base(id)}/reporte-herramientas/items/${fila.body.items[0].id}/dias/${fechas.inicio}`,
        )
        .set(operador())
        .send({ estado: 'operacion' })
        .expect(200);
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
        .post(`${base(t)}/reporte-herramientas/confirmar`)
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
          `INSERT INTO inventario.articulo (id, codigo, nombre, categoria_id, unidad_stock_id) VALUES ($1, $2, $3, $4, (SELECT id FROM catalogos.unidad_medida ORDER BY nombre LIMIT 1))`,
          [a.id, a.codigo, `Herramienta ${a.codigo}`, CAT],
        );
      }
      Object.assign(process.env, {
        SERVICE_NAME: 'operaciones-test',
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
      jest
        .spyOn(ActaEntregaConsumer.prototype, 'onApplicationBootstrap')
        .mockResolvedValue(undefined);
      jest
        .spyOn(ResultadoCambioItemsConsumer.prototype, 'onApplicationBootstrap')
        .mockResolvedValue(undefined);
      await app.init();
      prisma = app.get(PrismaService);
      consumer = app.get(PedidosAbiertosConsumer);
      actaConsumer = app.get(ActaEntregaConsumer);
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

    /** Lleva el ticket hasta el control de retorno. */
    const enRetorno = async () => {
      const t = await enEjecucion();
      await guardar(t.id, '2026-11-05').expect(200);
      await enviar(t.id, '2026-11-05').expect(201);
      await uso(t.id, t.cepillo, '2026-11-05').expect(200);
      await confirmarUso(t.id).expect(201);
      await finalizar(t.id).expect(201);
      await http()
        .post(`${base(t.id)}/aprobar-reportes`)
        .set(supervisor())
        .expect(201);
      return t;
    };
    const devolver = (t: string, cuerpo: Record<string, unknown> = {}, auth = bodega()) =>
      http()
        .post(`${base(t)}/herramientas/devolver`)
        .set(auth)
        .send(cuerpo);
    const faltante = (t: string, h: string, cuerpo: Record<string, unknown>, auth = bodega()) =>
      http()
        .post(`${base(t)}/herramientas/${h}/faltante`)
        .set(auth)
        .send(cuerpo);
    const eventoQhse = (tipo: string, ticketId: string) =>
      ({
        id: uuidv7(),
        type: tipo,
        version: 1,
        occurredAt: new Date().toISOString(),
        source: 'qhse',
        subject: { type: 'acta', id: uuidv7() },
        actor: { userId: SUPERVISOR.id, role: 'supervisor' },
        data: { ticketId },
      }) as EventEnvelope;

    describe('control de retorno de las herramientas', () => {
      it('Bodega devuelve las herramientas o las da por faltantes con causa y detalle; sin retorno completo no se sale', async () => {
        const t = await enRetorno();
        const pend = await http()
          .get('/api/operaciones/fcr/herramientas/pendientes-de-retorno')
          .set(bodega())
          .expect(200);
        expect(
          pend.body.filter((h: { ticket: { id: string } }) => h.ticket.id === t.id),
        ).toHaveLength(2);
        await http()
          .get('/api/operaciones/fcr/herramientas/pendientes-de-retorno')
          .set(supervisor())
          .expect(403);
        const falta = await avanzar(t.id, 'cierre', bodega()).expect(409);
        expect(q(falta)).toMatch(/Herramientas devueltas o con su faltante registrado/);
        // permisos y validaciones del faltante
        await faltante(
          t.id,
          t.magneto,
          { causa: 'perdida', detalle: 'Se cayó al pozo' },
          supervisor(),
        ).expect(403);
        await faltante(t.id, t.magneto, { causa: 'regalada', detalle: 'xxx' }).expect(400);
        await faltante(t.id, t.magneto, { causa: 'perdida', detalle: '  ' }).expect(400);
        await faltante(t.id, uuidv7(), { causa: 'perdida', detalle: 'No está' }).expect(404);
        const f = await faltante(t.id, t.magneto, {
          causa: 'perdida',
          detalle: 'Se cayó al pozo',
        }).expect(201);
        expect(f.body.herramientas.find((h: { id: string }) => h.id === t.magneto)).toMatchObject({
          estado: 'faltante',
          faltanteMotivo: 'Se cayó al pozo',
        });
        await faltante(t.id, t.magneto, { causa: 'dano', detalle: 'Otra vez' }).expect(409);
        // devolver: solo las recibidas sin retorno; con ids ajenos, 400
        await devolver(t.id, { herramientaIds: [uuidv7()] }).expect(400);
        await devolver(t.id, {}, supervisor()).expect(403);
        const d = await devolver(t.id).expect(201);
        expect(d.body.herramientas.find((h: { id: string }) => h.id === t.cepillo).estado).toBe(
          'devuelta',
        );
        await devolver(t.id).expect(409); // nada más por devolver
        // historia inmutable de cada herramienta
        const ev = await prisma.ticketHerramientaEvento.findMany({
          where: { herramientaId: t.magneto, tipo: 'faltante' },
        });
        expect(ev).toHaveLength(1);
        expect(ev[0].detalle).toBe('perdida: Se cayó al pozo');
        const fila = await prisma.ticketHerramienta.findUniqueOrThrow({ where: { id: t.magneto } });
        expect(fila).toMatchObject({ faltanteCausa: 'perdida', faltantePor: BODEGUERO.id });
        // fuera del control de retorno no se registra
        const otro = await enEjecucion();
        await devolver(otro.id).expect(409);
      });
    });

    describe('cierre del ticket', () => {
      const hastaCierre = async () => {
        const t = await enRetorno();
        await devolver(t.id).expect(201);
        await avanzar(t.id, 'cierre', bodega()).expect(201);
        return t;
      };

      it('no cierra sin el Acta de Entrega de Locación; QHSE la carga por evento y el cierre publica operaciones.fcr.cerrado una sola vez', async () => {
        const t = await hastaCierre();
        const falta = await avanzar(t.id, 'cerrado').expect(409);
        expect(q(falta)).toMatch(/Acta de Entrega de Locación cargada/);
        await avanzar(t.id, 'cerrado', operador()).expect(403);
        // el evento de otro ticket no cuenta; el de este, sí
        await actaConsumer.consumir(eventoQhse('qhse.acta_entrega.cargada', uuidv7()));
        await avanzar(t.id, 'cerrado').expect(409);
        await actaConsumer.consumir(eventoQhse('qhse.acta_entrega.cargada', t.id));
        await actaConsumer.consumir(eventoQhse('qhse.acta_entrega.anulada', t.id)); // se anula: vuelve a faltar
        await avanzar(t.id, 'cerrado').expect(409);
        await actaConsumer.consumir(eventoQhse('qhse.documento.acta_entrega_cargada', t.id)); // el otro nombre del contrato 4.11
        const r = await avanzar(t.id, 'cerrado').expect(201);
        expect(r.body.paso).toMatchObject({ codigo: 'cerrado', macro: 'aprobado' });
        expect(r.body.siguientes).toEqual([]);
        const cierre = await salidas(t.pedidoId, 'operaciones.fcr.cerrado');
        expect(cierre).toHaveLength(1);
        expect(cierre[0].d).toMatchObject({ ticketId: t.id, pedidoId: t.pedidoId });
        // cerrado es de solo lectura y no se cierra otra vez
        await avanzar(t.id, 'cerrado').expect(409);
        await avanzar(t.id, 'cierre').expect(409);
        await guardar(t.id, '2026-11-06').expect(409);
        // las observaciones se leen, pero un ticket cerrado ya no admite nuevas
        await http()
          .post(`${base(t.id)}/observaciones`)
          .set(supervisor())
          .send({ mensaje: 'Nota tardía' })
          .expect(409);
        await http()
          .get(`${base(t.id)}/observaciones`)
          .set(supervisor())
          .expect(200);
        await http()
          .post(`${base(t.id)}/herramientas`)
          .set(supervisor())
          .send({ articuloId: CEPILLO.id })
          .expect(409);
      });

      it('al cerrar pide el correo del cliente, lo normaliza y lo lleva en el evento sin guardarlo en FCR', async () => {
        const t = await hastaCierre();
        await actaConsumer.consumir(eventoQhse('qhse.acta_entrega.cargada', t.id));
        // sin correo, en blanco o inválido: no cierra y el ticket sigue en el cierre
        for (const malo of [undefined, '', '   ', 'sin-arroba', 'a@b', 'dos@@x.com']) {
          const r = await http()
            .post(`${base(t.id)}/avanzar`)
            .set(supervisor())
            .send({ hacia: 'cerrado', ...(malo !== undefined ? { correoCliente: malo } : {}) })
            .expect(400);
          expect(q(r)).toMatch(/correo del cliente/);
        }
        const aun = await http().get(base(t.id)).set(supervisor()).expect(200);
        expect(aun.body.paso.codigo).toBe('cierre');
        expect(await salidas(t.pedidoId, 'operaciones.fcr.cerrado')).toHaveLength(0);
        // con correo: se normaliza y viaja en el evento junto con el cliente y el pozo
        await avanzar(t.id, 'cerrado', supervisor(), undefined, '  Cliente@Empresa.COM ').expect(
          201,
        );
        const cierre = await salidas(t.pedidoId, 'operaciones.fcr.cerrado');
        expect(cierre).toHaveLength(1);
        expect(cierre[0].d).toMatchObject({
          ticketId: t.id,
          pedidoId: t.pedidoId,
          correoCliente: 'cliente@empresa.com',
          cliente: expect.any(String),
        });
        // FCR no lo guarda: ninguna tabla del schema tiene una columna de correo
        const columnas = await admin.query(
          "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'fcr' AND (column_name ILIKE '%correo%' OR column_name ILIKE '%email%')",
        );
        expect(columnas.rows).toEqual([]);
      });

      it('los demás pasos no piden el correo del cliente', async () => {
        const t = await enRetorno();
        await devolver(t.id).expect(201);
        // pasar al cierre no lo pide; si se envía en otro paso, se ignora: no lo lleva ningún evento
        const r = await avanzar(t.id, 'cierre', bodega(), undefined, 'otro@cliente.test').expect(
          201,
        );
        expect(r.body.paso.codigo).toBe('cierre');
        const fugas = await admin.query(
          "SELECT 1 FROM msg_operaciones.outbox WHERE datos->'data'->>'pedidoId' = $1 AND datos::text ILIKE '%otro@cliente.test%'",
          [t.pedidoId],
        );
        expect(fugas.rowCount).toBe(0);
      });

      it('el puente temporal confirma el Acta con motivo mientras QHSE no la publica', async () => {
        const t = await hastaCierre();
        const req = await prisma.ticketRequisito.findFirstOrThrow({
          where: { ticketId: t.id, requisitoCodigo: 'acta_entrega_locacion' },
        });
        await http()
          .post(`/api/operaciones/fcr/requisitos/${req.id}/cumplir`)
          .set(supervisor())
          .send({ motivo: 'sin permiso' })
          .expect(403);
        const jefe = tok(JEFE, [P.FCR_OPERAR, P.FCR_REQUISITOS_PUENTE]);
        await http()
          .post(`/api/operaciones/fcr/requisitos/${req.id}/cumplir`)
          .set(jefe)
          .send({ motivo: 'x' })
          .expect(400);
        await http()
          .post(`/api/operaciones/fcr/requisitos/${req.id}/cumplir`)
          .set(jefe)
          .send({ motivo: 'QHSE aún no publica el evento' })
          .expect(201);
        const fila = await prisma.ticketRequisito.findUniqueOrThrow({ where: { id: req.id } });
        expect(fila).toMatchObject({
          estado: 'cumplido',
          origen: 'manual_temporal',
          motivo: 'QHSE aún no publica el evento',
        });
        await avanzar(t.id, 'cerrado').expect(201);
      });

      it('recorrido completo con unidad: asignación, ejecución, retorno, reporte de llegada y cierre dejan toda la historia', async () => {
        const t = await hastaCierre();
        await actaConsumer.consumir(eventoQhse('qhse.acta_entrega.cargada', t.id));
        const r = await avanzar(t.id, 'cerrado').expect(201);
        expect(r.body.historial.map((h: { pasoNuevo: string }) => h.pasoNuevo)).toEqual([
          'revision_inicial',
          'preparacion_herramientas',
          'asignacion',
          'reunion_operativa',
          'ejecucion_operativa',
          'revision_reportes',
          'control_retorno',
          'cierre',
          'cerrado',
        ]);
        const tipos = (await salidas(t.pedidoId)).map((s) => s.tipo);
        for (const esperado of [
          'operaciones.fcr.ticket_creado',
          'operaciones.fcr.herramientas_solicitadas',
          'operaciones.fcr.asignacion_realizada',
          'operaciones.fcr.bitacora_enviada',
          'operaciones.fcr.reporte_herramientas_completado',
          'operaciones.fcr.cerrado',
        ]) {
          expect(tipos).toContain(esperado);
        }
        expect(tipos.filter((x) => x === 'operaciones.fcr.paso_cambiado')).toHaveLength(8);
      });
    });
  },
);
