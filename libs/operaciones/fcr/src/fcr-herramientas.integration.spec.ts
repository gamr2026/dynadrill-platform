/**
 * Integración real de las herramientas de FCR (F2): configuración por cliente y código, precarga desde el pedido, recarga y el recorrido
 * Supervisor → Bodega → Supervisor. Postgres real (PgBouncer, app_operaciones); el consumidor de pedidos se invoca a mano (sin RabbitMQ).
 *   RUN_INTEGRATION=1 npx jest --config libs/operaciones/fcr/jest.config.cts herramientas
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

const SUPERVISOR = { id: uuidv7(), nombre: 'Sara Supervisora FCR' };
const OTRO_SUPERVISOR = { id: uuidv7(), nombre: 'Saúl Supervisor FCR' };
const VENTAS = { id: uuidv7(), nombre: 'Vera Ingeniería de Ventas' };
const BODEGUERO = { id: uuidv7(), nombre: 'Bruno Bodeguero' };
const OPERADOR = { id: uuidv7(), nombre: 'Olga Operadora FCR' };
const CLIENTE = { id: uuidv7(), nombre: `Cliente HF ${n}`, ruc: `86${String(n).slice(-11)}` };
const OTRO_CLIENTE = {
  id: uuidv7(),
  nombre: `Otro Cliente HF ${n}`,
  ruc: `85${String(n).slice(-11)}`,
};
const CAMPO = { id: uuidv7(), nombre: `SACHA HF ${n}` };
const BLOQUE = { id: uuidv7(), nombre: `Bloque HF ${n}` };
const POZO = { id: uuidv7(), nombre: `HF-POZO-${n}`, campoId: CAMPO.id, bloqueId: BLOQUE.id };
const CAT_HERRAMIENTAS = uuidv7();
const CAT_QUIMICA = uuidv7();
const articulo = (sufijo: string) => ({ id: uuidv7(), codigo: `HF-${sufijo}-${n}` });
const CEPILLO = articulo('CEP');
const MAGNETO = articulo('MAG');
const CANASTA = articulo('CAN');
const QUIMICO = articulo('QUI');
const BAJA = articulo('BAJ');
const MAESTROS: MaestrosDePrueba = {
  usuarios: [
    { id: SUPERVISOR.id, nombre: SUPERVISOR.nombre, rol: 'supervisor' },
    { id: OTRO_SUPERVISOR.id, nombre: OTRO_SUPERVISOR.nombre, rol: 'supervisor' },
    { id: VENTAS.id, nombre: VENTAS.nombre, rol: 'ingenieria_ventas' },
    { id: BODEGUERO.id, nombre: BODEGUERO.nombre, rol: 'bodeguero' },
    { id: OPERADOR.id, nombre: OPERADOR.nombre, rol: 'operador_fcr' },
  ],
  clientes: [CLIENTE, OTRO_CLIENTE],
  campos: [CAMPO],
  bloques: [BLOQUE],
  pozos: [POZO],
};

run(
  'FCR: herramientas, configuración por cliente y código y flujo con Bodega (base de datos real)',
  () => {
    jest.setTimeout(120000);
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
    const token = (roleCode: string, name: string, permissions: string[], sub: string) => ({
      Authorization: `Bearer ${signer.sign({ sub, email: `${roleCode}@test.local`, name, roleId: 'r', roleCode, permissions })}`,
    });
    const supervisor = () =>
      token('supervisor', SUPERVISOR.nombre, [P.FCR_OPERAR, P.FCR_VER], SUPERVISOR.id);
    const otroSupervisor = () =>
      token('supervisor', OTRO_SUPERVISOR.nombre, [P.FCR_OPERAR, P.FCR_VER], OTRO_SUPERVISOR.id);
    const ventas = () =>
      token(
        'ingenieria_ventas',
        VENTAS.nombre,
        [P.FCR_VER, P.FCR_CONFIGURACION_GESTIONAR],
        VENTAS.id,
      );
    const bodega = () =>
      token(
        'bodeguero',
        BODEGUERO.nombre,
        [P.FCR_OPERAR, P.FCR_VER, P.FCR_HERRAMIENTAS_PREPARAR],
        BODEGUERO.id,
      );
    const operador = () => token('operador_fcr', OPERADOR.nombre, [P.FCR_OPERAR], OPERADOR.id);

    const pedidos: string[] = [];
    const eventos: string[] = [];
    let ticketSeq = 600_000 + (n % 100_000) * 10;
    let codigoSeq = 0;
    /** Códigos de lista de precios únicos por corrida. */
    const cod = (base: string) => `${base}-${n}-${codigoSeq++}`;

    const evento = (
      tipo: string,
      pedidoId: string,
      data: Record<string, unknown>,
    ): EventEnvelope => {
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
    const abierto = (data: Record<string, unknown> = {}, pedidoId = uuidv7()) =>
      evento('comercial.pedido.abierto', pedidoId, {
        codigo: `PED-HF${n}`,
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
        fechaInicioServicio: '2026-11-05',
        fechaFinServicio: '2026-11-12',
        lineas: [],
        ...data,
      });
    const linea = (
      codigo: string,
      cantidad: number,
      extra: Partial<{ unidad: string; tipoLinea: string; descripcion: string }> = {},
    ) => ({
      codigo,
      descripcion: extra.descripcion ?? `Línea ${codigo}`,
      unidad: extra.unidad ?? 'Corrida',
      cantidad,
      tipoLinea: extra.tipoLinea ?? 'herramienta',
    });

    const crear = async (data: Record<string, unknown> = {}) => {
      const e = abierto(data);
      await consumer.consumir(e);
      const t = await prisma.ticket.findUniqueOrThrow({ where: { pedidoId: e.subject.id } });
      return { id: t.id, pedidoId: e.subject.id };
    };
    const config = (clienteId: string, codigo: string, kit: Array<[{ id: string }, number]>) =>
      http()
        .put('/api/operaciones/fcr/configuracion-codigos')
        .set(ventas())
        .send({
          clienteId,
          codigo,
          clasificacion: 'herramienta',
          kit: kit.map(([a, cantidad]) => ({ articuloId: a.id, cantidad })),
        });
    const herramientas = async (id: string, auth = supervisor()) =>
      (await http().get(`/api/operaciones/fcr/tickets/${id}/herramientas`).set(auth).expect(200))
        .body;
    const url = (id: string, resto = '') =>
      `/api/operaciones/fcr/tickets/${id}/herramientas${resto}`;
    const avanzar = (id: string, hacia: string, auth = supervisor()) =>
      http().post(`/api/operaciones/fcr/tickets/${id}/avanzar`).set(auth).send({ hacia });
    /** Texto del error (el filtro de errores solo devuelve `detail`/`message` y `code`). */
    const que = (r: { body: { detail?: string; message?: string } }) =>
      String(r.body.detail ?? r.body.message);
    const conteo = (lista: { herramientas: Array<{ articuloId: string }> }, a: { id: string }) =>
      lista.herramientas.filter((h) => h.articuloId === a.id).length;

    /** Ticket de venta en la preparación de herramientas, tomado por el Supervisor, con un cepillo y un magneto del pedido. */
    const enPreparacion = async () => {
      const c = cod('SH');
      await config(CLIENTE.id, c, [
        [CEPILLO, 1],
        [MAGNETO, 1],
      ]).expect(200);
      const t = await crear({ lineas: [linea(c, 1)] });
      await avanzar(t.id, 'preparacion_herramientas').expect(201);
      return t;
    };
    const ids = (lista: { herramientas: Array<{ id: string }> }) =>
      lista.herramientas.map((h) => h.id);

    beforeAll(async () => {
      await sembrarMaestros(admin, MAESTROS);
      await admin.query(
        'INSERT INTO inventario.categoria_articulo (id, nombre, lleva_partes) VALUES ($1, $2, true), ($3, $4, false)',
        [CAT_HERRAMIENTAS, `CAT-HERR-HF ${n}`, CAT_QUIMICA, `CAT-QUI-HF ${n}`],
      );
      for (const [a, cat, activo] of [
        [CEPILLO, CAT_HERRAMIENTAS, true],
        [MAGNETO, CAT_HERRAMIENTAS, true],
        [CANASTA, CAT_HERRAMIENTAS, true],
        [BAJA, CAT_HERRAMIENTAS, true],
        [QUIMICO, CAT_QUIMICA, true],
      ] as const) {
        await admin.query(
          `INSERT INTO inventario.articulo (id, codigo, nombre, categoria_id, unidad_stock_id, activo)
         VALUES ($1, $2, $3, $4, (SELECT id FROM inventario.unidad_stock ORDER BY nombre LIMIT 1), $5)`,
          [a.id, a.codigo, `Herramienta ${a.codigo}`, cat, activo],
        );
      }
      Object.assign(process.env, {
        SERVICE_NAME: 'operaciones-test',
        PORT: '3198',
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
      // sin RabbitMQ: los consumidores se invocan a mano
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
    });

    afterAll(async () => {
      const deTickets = '(SELECT id FROM fcr.ticket WHERE pedido_id = ANY($1::uuid[]))';
      if (pedidos.length) {
        await admin.query(
          `DELETE FROM fcr.ticket_herramienta_evento WHERE herramienta_id IN (SELECT id FROM fcr.ticket_herramienta WHERE ticket_id IN ${deTickets})`,
          [pedidos],
        );
        await admin.query('DELETE FROM fcr.ticket WHERE pedido_id = ANY($1::uuid[])', [pedidos]);
        await admin.query(
          "DELETE FROM msg_operaciones.outbox WHERE datos->'data'->>'pedidoId' = ANY($1::text[])",
          [pedidos],
        );
      }
      await admin.query('DELETE FROM fcr.configuracion_codigo WHERE cliente_id = ANY($1::uuid[])', [
        [CLIENTE.id, OTRO_CLIENTE.id],
      ]);
      if (eventos.length)
        await admin.query('DELETE FROM msg_operaciones.inbox WHERE id = ANY($1::uuid[])', [
          eventos,
        ]);
      await admin.query('DELETE FROM inventario.articulo WHERE categoria_id = ANY($1::uuid[])', [
        [CAT_HERRAMIENTAS, CAT_QUIMICA],
      ]);
      await admin.query('DELETE FROM inventario.categoria_articulo WHERE id = ANY($1::uuid[])', [
        [CAT_HERRAMIENTAS, CAT_QUIMICA],
      ]);
      await quitarMaestros(admin, MAESTROS);
      await admin.end();
      await appPool.end();
      await app.close();
    });

    describe('configuración por cliente y código', () => {
      it('Ingeniería de Ventas arma el kit de un código de herramienta; guardar de nuevo reemplaza el kit completo', async () => {
        const c = cod('SH1101');
        const r = await config(CLIENTE.id, c, [
          [CEPILLO, 2],
          [MAGNETO, 1],
        ]).expect(200);
        expect(r.body).toMatchObject({
          clienteId: CLIENTE.id,
          codigo: c,
          clasificacion: 'herramienta',
        });
        expect(
          r.body.kit
            .map((k: { codigo: string; cantidad: number }) => [k.codigo, k.cantidad])
            .sort(),
        ).toEqual(
          [
            [CEPILLO.codigo, 2],
            [MAGNETO.codigo, 1],
          ].sort(),
        );
        const otra = await config(CLIENTE.id, c, [[CANASTA, 3]]).expect(200);
        expect(otra.body.id).toBe(r.body.id);
        expect(otra.body.kit).toHaveLength(1);
        expect(otra.body.kit[0]).toMatchObject({
          codigo: CANASTA.codigo,
          cantidad: 3,
          activo: true,
        });
        // cada cliente tiene su propia configuración del mismo código
        await config(OTRO_CLIENTE.id, c, [[CEPILLO, 1]]).expect(200);
        const lista = await http()
          .get(`/api/operaciones/fcr/configuracion-codigos?clienteId=${CLIENTE.id}`)
          .set(supervisor())
          .expect(200);
        expect(lista.body.filter((x: { codigo: string }) => x.codigo === c)).toHaveLength(1);
        expect(
          (
            await http()
              .get(`/api/operaciones/fcr/configuracion-codigos?clienteId=${OTRO_CLIENTE.id}`)
              .set(ventas())
              .expect(200)
          ).body[0].kit[0].codigo,
        ).toBe(CEPILLO.codigo);
      });

      it('un código de servicio no lleva kit; pasar un código de herramienta a servicio vacía su kit', async () => {
        const c = cod('SFS');
        const kit = [{ articuloId: CEPILLO.id, cantidad: 1 }];
        const base = { clienteId: CLIENTE.id, codigo: c, clasificacion: 'servicio' as const };
        await http()
          .put('/api/operaciones/fcr/configuracion-codigos')
          .set(ventas())
          .send({ ...base, kit })
          .expect(400);
        await config(CLIENTE.id, c, [[CEPILLO, 1]]).expect(200);
        const r = await http()
          .put('/api/operaciones/fcr/configuracion-codigos')
          .set(ventas())
          .send({ ...base, kit: [] })
          .expect(200);
        expect(r.body).toMatchObject({ clasificacion: 'servicio', kit: [] });
        expect(
          await prisma.configuracionCodigoKit.count({ where: { configuracion: { codigo: c } } }),
        ).toBe(0);
      });

      it('valida el kit: solo herramientas activas del inventario, sin repetidos, cantidades razonables y cliente real', async () => {
        const c = cod('SHX');
        await config(CLIENTE.id, c, [[QUIMICO, 1]]).expect(400); // categoría sin partes
        await config(CLIENTE.id, c, [[{ id: uuidv7() }, 1]]).expect(400);
        await config(CLIENTE.id, c, [
          [CEPILLO, 1],
          [CEPILLO, 2],
        ]).expect(400);
        await config(CLIENTE.id, c, [[CEPILLO, 0]]).expect(400);
        await config(CLIENTE.id, c, [[CEPILLO, 1000]]).expect(400);
        await config(uuidv7(), c, [[CEPILLO, 1]]).expect(400);
        await admin.query('UPDATE inventario.articulo SET activo = false WHERE id = $1', [BAJA.id]);
        await config(CLIENTE.id, c, [[BAJA, 1]]).expect(400);
        await admin.query('UPDATE inventario.articulo SET activo = true WHERE id = $1', [BAJA.id]);
        expect(await prisma.configuracionCodigo.count({ where: { codigo: c } })).toBe(0);
      });

      it('configurar es de Ingeniería de Ventas y administradores; leer, de los roles de FCR; borrar quita la configuración', async () => {
        const c = cod('SHP');
        const cuerpo = { clienteId: CLIENTE.id, codigo: c, clasificacion: 'herramienta', kit: [] };
        await http()
          .put('/api/operaciones/fcr/configuracion-codigos')
          .set(supervisor())
          .send(cuerpo)
          .expect(403);
        const r = await http()
          .put('/api/operaciones/fcr/configuracion-codigos')
          .set(ventas())
          .send(cuerpo)
          .expect(200);
        await http().get('/api/operaciones/fcr/configuracion-codigos').set(ventas()).expect(400); // falta el cliente
        await http()
          .delete(`/api/operaciones/fcr/configuracion-codigos/${r.body.id}`)
          .set(supervisor())
          .expect(403);
        await http()
          .delete(`/api/operaciones/fcr/configuracion-codigos/${r.body.id}`)
          .set(ventas())
          .expect(204);
        await http()
          .delete(`/api/operaciones/fcr/configuracion-codigos/${r.body.id}`)
          .set(ventas())
          .expect(404);
      });

      it('busca herramientas del inventario para el kit (mínimo 2 letras; sin químicos ni artículos de baja)', async () => {
        const r = await http()
          .get(`/api/operaciones/fcr/herramientas-disponibles?q=HF-CEP-${n}`)
          .set(ventas())
          .expect(200);
        expect(r.body.map((a: { codigo: string }) => a.codigo)).toEqual([CEPILLO.codigo]);
        const q = await http()
          .get(`/api/operaciones/fcr/herramientas-disponibles?q=HF-QUI-${n}`)
          .set(ventas())
          .expect(200);
        expect(q.body).toEqual([]);
        await http()
          .get('/api/operaciones/fcr/herramientas-disponibles?q=a')
          .set(ventas())
          .expect(400);
      });

      it('las reglas de la base: solo una herramienta lleva kit, solo artículos con partes, un código por cliente y cantidades válidas', async () => {
        const c = cod('SHD');
        const r = (await config(CLIENTE.id, c, [[CEPILLO, 1]]).expect(200)).body;
        const rechaza = (sql: string, params: unknown[], patron: RegExp) =>
          expect(admin.query(sql, params)).rejects.toThrow(patron);
        // un código de servicio no puede tener kit (FK compuesta con la clasificación)
        await rechaza(
          "UPDATE fcr.configuracion_codigo SET clasificacion = 'servicio' WHERE id = $1",
          [r.id],
          /configuracion_codigo_kit_configuracion_fkey/,
        );
        // un artículo que no es herramienta no entra a un kit (disparador)
        await rechaza(
          'INSERT INTO fcr.configuracion_codigo_kit (configuracion_id, articulo_id, cantidad, created_by) VALUES ($1, $2, 1, $3)',
          [r.id, QUIMICO.id, VENTAS.id],
          /no es una herramienta activa/,
        );
        await rechaza(
          'UPDATE fcr.configuracion_codigo_kit SET cantidad = 0 WHERE configuracion_id = $1',
          [r.id],
          /configuracion_codigo_kit_cantidad_check/,
        );
        await rechaza(
          "INSERT INTO fcr.configuracion_codigo (id, cliente_id, codigo, clasificacion, created_by, updated_by) VALUES ($1, $2, $3, 'servicio', $4, $4)",
          [uuidv7(), CLIENTE.id, c, VENTAS.id],
          /configuracion_codigo_cliente_codigo_key/,
        );
        await rechaza(
          "INSERT INTO fcr.configuracion_codigo (id, cliente_id, codigo, clasificacion, created_by, updated_by) VALUES ($1, $2, '  ', 'servicio', $3, $3)",
          [uuidv7(), CLIENTE.id, VENTAS.id],
          /configuracion_codigo_codigo_check/,
        );
        await rechaza(
          "INSERT INTO fcr.configuracion_codigo (id, cliente_id, codigo, clasificacion, created_by, updated_by) VALUES ($1, $2, 'ZZ', 'servicio', $3, $3)",
          [uuidv7(), uuidv7(), VENTAS.id],
          /configuracion_codigo_cliente_fkey/,
        );
      });
    });

    describe('precarga de herramientas desde el pedido', () => {
      it('2 corridas piden 2 juegos del kit y cada herramienta física es una fila; 5 días piden un solo juego', async () => {
        const corrida = cod('SH1101');
        const diario = cod('SH2202');
        await config(CLIENTE.id, corrida, [
          [CEPILLO, 2],
          [MAGNETO, 1],
        ]).expect(200);
        await config(CLIENTE.id, diario, [[CANASTA, 1]]).expect(200);
        const t = await crear({
          lineas: [linea(corrida, 2), linea(diario, 5, { unidad: 'Días' })],
        });
        const lista = await herramientas(t.id);
        expect(conteo(lista, CEPILLO)).toBe(4);
        expect(conteo(lista, MAGNETO)).toBe(2);
        expect(conteo(lista, CANASTA)).toBe(1);
        expect(lista.herramientas).toHaveLength(7);
        expect(lista.herramientas[0]).toMatchObject({
          origen: 'pedido',
          estado: 'seleccionada',
          agregadaTarde: false,
        });
        expect(
          lista.herramientas.map((h: { codigoPedido: string }) => h.codigoPedido).sort()[0],
        ).toBe([corrida, diario].sort()[0]);
        expect(lista.avisosPrecarga).toEqual([]);
        expect(lista.listadoConfirmado).toBe(false);
        // las líneas cotizadas quedan en el ticket
        expect(await prisma.ticketLinea.count({ where: { ticketId: t.id } })).toBe(2);
        // las herramientas precargadas quedan atribuidas a nadie si quien abrió el pedido no es una cuenta
        const h = await prisma.ticketHerramienta.findFirstOrThrow({ where: { ticketId: t.id } });
        expect(h.createdBy).toBeNull();
      });

      it('la movilización se muestra aparte y no genera herramientas, aunque su código esté configurado', async () => {
        const mov = cod('SFS6146');
        await config(CLIENTE.id, mov, [[CEPILLO, 1]]).expect(200);
        const t = await crear({
          lineas: [
            linea(mov, 1, {
              tipoLinea: 'movilizacion',
              unidad: 'Unidad',
              descripcion: 'Movilización',
            }),
          ],
        });
        const lista = await herramientas(t.id);
        expect(lista.herramientas).toEqual([]);
        expect(lista.movilizaciones).toEqual([
          { codigo: mov, descripcion: 'Movilización', unidad: 'Unidad', cantidad: 1 },
        ]);
      });

      it('lo que no se puede resolver queda como aviso para el Supervisor y no impide crear el ticket', async () => {
        const sinConfigurar = cod('SH9999');
        const kitVacio = cod('SH0000');
        const servicio = cod('SFS0001');
        const articuloDeBaja = cod('SH7777');
        const noLinea = cod('SFS0002');
        await config(CLIENTE.id, kitVacio, []).expect(200);
        await http()
          .put('/api/operaciones/fcr/configuracion-codigos')
          .set(ventas())
          .send({ clienteId: CLIENTE.id, codigo: servicio, clasificacion: 'servicio', kit: [] })
          .expect(200);
        await config(CLIENTE.id, articuloDeBaja, [
          [BAJA, 1],
          [MAGNETO, 1],
        ]).expect(200);
        await admin.query('UPDATE inventario.articulo SET activo = false WHERE id = $1', [BAJA.id]);
        try {
          const t = await crear({
            lineas: [
              linea(sinConfigurar, 1),
              linea(kitVacio, 1),
              linea(servicio, 1),
              linea(articuloDeBaja, 1),
              linea(noLinea, 1, { tipoLinea: 'servicio' }),
            ],
          });
          const lista = await herramientas(t.id);
          const motivos = lista.avisosPrecarga.map((a: { motivo: string; codigo: string }) => [
            a.motivo,
            a.codigo,
          ]);
          expect(motivos).toEqual(
            expect.arrayContaining([
              ['sin_configurar', sinConfigurar],
              ['kit_vacio', kitVacio],
              ['articulo_inactivo', articuloDeBaja],
            ]),
          );
          // un código de servicio y una línea de servicio sin configuración no avisan (no piden herramientas)
          expect(lista.avisosPrecarga).toHaveLength(3);
          expect(
            lista.avisosPrecarga.find((a: { motivo: string }) => a.motivo === 'articulo_inactivo')
              .articulo,
          ).toContain(BAJA.codigo);
          // del kit con un artículo de baja solo se carga el vigente
          expect(lista.herramientas.map((h: { articuloId: string }) => h.articuloId)).toEqual([
            MAGNETO.id,
          ]);
        } finally {
          await admin.query('UPDATE inventario.articulo SET activo = true WHERE id = $1', [
            BAJA.id,
          ]);
        }
      });

      it('un pedido sin cliente no precarga nada y avisa de cada línea de herramienta', async () => {
        const c = cod('SH5555');
        const t = await crear({
          clienteId: null,
          lineas: [linea(c, 1), linea(cod('SFS'), 1, { tipoLinea: 'servicio' })],
        });
        const lista = await herramientas(t.id);
        expect(lista.herramientas).toEqual([]);
        expect(lista.avisosPrecarga).toEqual([
          expect.objectContaining({ motivo: 'pedido_sin_cliente', codigo: c }),
        ]);
      });

      it('un ticket sin herramientas tiene cumplido el requisito de herramientas recibidas; con herramientas, pendiente', async () => {
        const vacio = await crear({ lineas: [] });
        const con = await enPreparacion();
        const estado = async (id: string) =>
          (
            await prisma.ticketRequisito.findFirstOrThrow({
              where: { ticketId: id, requisitoCodigo: 'herramientas_recibidas' },
            })
          ).estado;
        expect(await estado(vacio.id)).toBe('cumplido');
        expect(await estado(con.id)).toBe('pendiente');
      });

      it('el pedido actualizado cambia las fechas y las líneas del ticket, pero no toca las herramientas hasta recargar', async () => {
        const c = cod('SH3030');
        await config(CLIENTE.id, c, [[CEPILLO, 1]]).expect(200);
        const t = await crear({ lineas: [linea(c, 1)] });
        await avanzar(t.id, 'preparacion_herramientas').expect(201);
        expect(conteo(await herramientas(t.id), CEPILLO)).toBe(1);
        await consumer.consumir(
          evento('comercial.pedido.actualizado', t.pedidoId, {
            codigo: `PED-HF${n}`,
            itemsModificados: true,
            fechaInicioServicio: '2026-11-06',
            fechaFinServicio: '2026-11-20',
            lineas: [linea(c, 3)],
          }),
        );
        const fila = await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } });
        expect(fila.fechaInicioServicio?.toISOString().slice(0, 10)).toBe('2026-11-06');
        expect(fila.fechaFinServicio?.toISOString().slice(0, 10)).toBe('2026-11-20');
        expect(
          Number(
            (await prisma.ticketLinea.findFirstOrThrow({ where: { ticketId: t.id } })).cantidad,
          ),
        ).toBe(3);
        expect(conteo(await herramientas(t.id), CEPILLO)).toBe(1);
        // un evento de actualización de un pedido sin ticket (o sin cambios de ítems) se ignora sin error
        await consumer.consumir(
          evento('comercial.pedido.actualizado', uuidv7(), { codigo: 'X', lineas: [] }),
        );
        await consumer.consumir(
          evento('comercial.pedido.actualizado', t.pedidoId, {
            codigo: 'X',
            itemsModificados: false,
          }),
        );
        expect(await prisma.ticketLinea.count({ where: { ticketId: t.id } })).toBe(1);
      });

      it('«Recargar desde el pedido» agrega lo que falta, conserva lo solicitado y lo agregado a mano, y quita lo que no se solicitó', async () => {
        const c = cod('SH4040');
        await config(CLIENTE.id, c, [
          [CEPILLO, 1],
          [MAGNETO, 1],
        ]).expect(200);
        const t = await crear({ lineas: [linea(c, 1)] });
        await avanzar(t.id, 'preparacion_herramientas').expect(201);
        // el Supervisor agrega una canasta a mano y solicita el cepillo
        await http().post(url(t.id)).set(supervisor()).send({ articuloId: CANASTA.id }).expect(201);
        const antes = await herramientas(t.id);
        const cepillo = antes.herramientas.find(
          (h: { articuloId: string }) => h.articuloId === CEPILLO.id,
        );
        await http()
          .post(url(t.id, '/solicitar'))
          .set(supervisor())
          .send({ herramientaIds: [cepillo.id] })
          .expect(201);
        // el pedido ahora pide 3 corridas y el kit pierde el magneto
        await consumer.consumir(
          evento('comercial.pedido.actualizado', t.pedidoId, {
            codigo: 'X',
            itemsModificados: true,
            lineas: [linea(c, 3)],
          }),
        );
        await config(CLIENTE.id, c, [[CEPILLO, 1]]).expect(200);
        const r = await http().post(url(t.id, '/recargar')).set(supervisor()).expect(201);
        // 3 juegos de cepillo: el solicitado se conserva y se agregan 2; el magneto (sin solicitar) se quita; la canasta manual sigue
        expect(conteo(r.body, CEPILLO)).toBe(3);
        expect(conteo(r.body, MAGNETO)).toBe(0);
        expect(conteo(r.body, CANASTA)).toBe(1);
        expect(r.body.herramientas.find((h: { id: string }) => h.id === cepillo.id)).toMatchObject({
          estado: 'solicitada',
        });
        // recargar de nuevo no duplica
        const otra = await http().post(url(t.id, '/recargar')).set(supervisor()).expect(201);
        expect(conteo(otra.body, CEPILLO)).toBe(3);
        // y no se puede con el listado confirmado
        await http()
          .post(url(t.id, '/confirmar-listado'))
          .set(supervisor())
          .send({ confirmado: true })
          .expect(201);
        await http().post(url(t.id, '/recargar')).set(supervisor()).expect(409);
      });
    });

    describe('flujo Supervisor → Bodega → Supervisor', () => {
      it('agrega a mano una herramienta real y la quita mientras no se haya solicitado; no acepta químicos ni inexistentes', async () => {
        const t = await enPreparacion();
        await http().post(url(t.id)).set(supervisor()).send({ articuloId: QUIMICO.id }).expect(400);
        await http().post(url(t.id)).set(supervisor()).send({ articuloId: uuidv7() }).expect(400);
        const r = await http()
          .post(url(t.id))
          .set(supervisor())
          .send({ articuloId: CANASTA.id })
          .expect(201);
        const manual = r.body.herramientas.find(
          (h: { articuloId: string }) => h.articuloId === CANASTA.id,
        );
        expect(manual).toMatchObject({
          origen: 'manual',
          codigoPedido: null,
          agregadaTarde: false,
        });
        const q = await http()
          .delete(url(t.id, `/${manual.id}`))
          .set(supervisor())
          .expect(200);
        expect(conteo(q.body, CANASTA)).toBe(0);
        await http()
          .delete(url(t.id, `/${uuidv7()}`))
          .set(supervisor())
          .expect(404);
      });

      it('solicita todo a Bodega, le avisa por evento, y no deja quitar ni volver a solicitar lo ya solicitado', async () => {
        const t = await enPreparacion();
        const r = await http().post(url(t.id, '/solicitar')).set(supervisor()).send({}).expect(201);
        expect(
          r.body.herramientas.every((h: { estado: string }) => h.estado === 'solicitada'),
        ).toBe(true);
        const salida = await admin.query(
          "SELECT datos->'data' AS d FROM msg_operaciones.outbox WHERE tipo = 'operaciones.fcr.herramientas_solicitadas' AND datos->'data'->>'pedidoId' = $1",
          [t.pedidoId],
        );
        expect(salida.rows).toHaveLength(1);
        expect(salida.rows[0].d).toMatchObject({
          cantidad: 2,
          solicitadoPor: SUPERVISOR.nombre,
          pozo: POZO.nombre,
        });
        await http().post(url(t.id, '/solicitar')).set(supervisor()).send({}).expect(409);
        await http()
          .delete(url(t.id, `/${r.body.herramientas[0].id}`))
          .set(supervisor())
          .expect(409);
        // una herramienta agregada después de salir la tanda original se marca como «tarde» y se solicita aparte
        const tarde = await http()
          .post(url(t.id))
          .set(supervisor())
          .send({ articuloId: CANASTA.id })
          .expect(201);
        expect(
          tarde.body.herramientas.find((h: { articuloId: string }) => h.articuloId === CANASTA.id)
            .agregadaTarde,
        ).toBe(true);
        const solo = await http()
          .post(url(t.id, '/solicitar'))
          .set(supervisor())
          .send({})
          .expect(201);
        expect(
          solo.body.herramientas.every((h: { estado: string }) => h.estado === 'solicitada'),
        ).toBe(true);
        // solicitar una herramienta que no es del ticket
        await http()
          .post(url(t.id, '/solicitar'))
          .set(supervisor())
          .send({ herramientaIds: [uuidv7()] })
          .expect(409);
      });

      it('Bodega prepara (con o sin novedad), corrige, envía; el Supervisor recibe (con o sin novedad) y corrige; todo queda en la historia', async () => {
        const t = await enPreparacion();
        await http().post(url(t.id, '/solicitar')).set(supervisor()).send({}).expect(201);
        const [a, b] = ids(await herramientas(t.id));
        // Bodega ve lo pendiente de todos los tickets
        const pend = await http()
          .get('/api/operaciones/fcr/herramientas/pendientes-de-bodega')
          .set(bodega())
          .expect(200);
        const mias = pend.body.filter((h: { ticket: { id: string } }) => h.ticket.id === t.id);
        expect(mias).toHaveLength(2);
        expect(mias[0].ticket).toMatchObject({
          pedidoCodigo: `PED-HF${n}`,
          cliente: CLIENTE.nombre,
          pozo: POZO.nombre,
        });

        // no se envía lo que no está preparado ni se recibe lo que no se envió
        await http()
          .post(url(t.id, `/${a}/enviar`))
          .set(bodega())
          .expect(409);
        await http()
          .post(url(t.id, `/${a}/recibir`))
          .set(supervisor())
          .send({})
          .expect(409);
        // preparar con novedad: no avanza
        const nov = await http()
          .post(url(t.id, `/${a}/preparar`))
          .set(bodega())
          .send({ novedad: 'Falta el sello' })
          .expect(201);
        expect(nov.body.herramientas.find((h: { id: string }) => h.id === a)).toMatchObject({
          estado: 'novedad_bodega',
          bodegaNovedad: 'Falta el sello',
        });
        await http()
          .post(url(t.id, `/${a}/enviar`))
          .set(bodega())
          .expect(409);
        // resuelta la novedad, se prepara sin novedad
        const ok = await http()
          .post(url(t.id, `/${a}/preparar`))
          .set(bodega())
          .send({})
          .expect(201);
        expect(ok.body.herramientas.find((h: { id: string }) => h.id === a)).toMatchObject({
          estado: 'preparada',
          bodegaNovedad: null,
        });
        await http()
          .post(url(t.id, `/${a}/preparar`))
          .set(bodega())
          .send({})
          .expect(409);
        // corregir la preparación la devuelve a solicitada
        const corr = await http()
          .delete(url(t.id, `/${a}/preparacion`))
          .set(bodega())
          .expect(200);
        expect(corr.body.herramientas.find((h: { id: string }) => h.id === a).estado).toBe(
          'solicitada',
        );
        await http()
          .delete(url(t.id, `/${a}/preparacion`))
          .set(bodega())
          .expect(409);
        await http()
          .post(url(t.id, `/${a}/preparar`))
          .set(bodega())
          .send({})
          .expect(201);
        const env = await http()
          .post(url(t.id, `/${a}/enviar`))
          .set(bodega())
          .expect(201);
        expect(env.body.herramientas.find((h: { id: string }) => h.id === a).estado).toBe(
          'enviada',
        );
        // enviada ya no se corrige en Bodega
        await http()
          .delete(url(t.id, `/${a}/preparacion`))
          .set(bodega())
          .expect(409);
        // el Supervisor la recibe con novedad (queda detenida) y luego sin novedad
        const rn = await http()
          .post(url(t.id, `/${a}/recibir`))
          .set(supervisor())
          .send({ novedad: 'Golpe en la rosca' })
          .expect(201);
        expect(rn.body.herramientas.find((h: { id: string }) => h.id === a)).toMatchObject({
          estado: 'novedad_recepcion',
          recepcionNovedad: 'Golpe en la rosca',
        });
        const rok = await http()
          .post(url(t.id, `/${a}/recibir`))
          .set(supervisor())
          .send({})
          .expect(201);
        expect(rok.body.herramientas.find((h: { id: string }) => h.id === a)).toMatchObject({
          estado: 'recibida',
          recepcionNovedad: null,
        });
        await http()
          .post(url(t.id, `/${a}/recibir`))
          .set(supervisor())
          .send({})
          .expect(409);
        const rc = await http()
          .delete(url(t.id, `/${a}/recepcion`))
          .set(supervisor())
          .expect(200);
        expect(rc.body.herramientas.find((h: { id: string }) => h.id === a).estado).toBe('enviada');
        await http()
          .delete(url(t.id, `/${a}/recepcion`))
          .set(supervisor())
          .expect(409);
        await http()
          .post(url(t.id, `/${a}/recibir`))
          .set(supervisor())
          .send({})
          .expect(201);

        // la otra herramienta sigue su propio camino
        expect(
          (await herramientas(t.id)).herramientas.find((h: { id: string }) => h.id === b).estado,
        ).toBe('solicitada');

        // toda la historia de la herramienta, en orden
        const hist = await prisma.ticketHerramientaEvento.findMany({
          where: { herramientaId: a },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        });
        expect(hist.map((e) => e.tipo)).toEqual([
          'solicitada',
          'preparada_con_novedad',
          'preparada',
          'preparacion_corregida',
          'preparada',
          'enviada',
          'recibida_con_novedad',
          'recibida',
          'recepcion_corregida',
          'recibida',
        ]);
        expect(hist[1]).toMatchObject({ detalle: 'Falta el sello', actorId: BODEGUERO.id });
        expect(hist[6]).toMatchObject({ detalle: 'Golpe en la rosca', actorId: SUPERVISOR.id });
      });

      it('cada acción es de su rol: Bodega no solicita ni recibe; el Supervisor no prepara ni envía; otro Supervisor ni el operador entran', async () => {
        const t = await enPreparacion();
        await http().post(url(t.id, '/solicitar')).set(bodega()).send({}).expect(403);
        await http().post(url(t.id, '/solicitar')).set(otroSupervisor()).send({}).expect(403);
        await http().post(url(t.id, '/solicitar')).set(operador()).send({}).expect(403);
        await http()
          .post(url(t.id))
          .set(otroSupervisor())
          .send({ articuloId: CANASTA.id })
          .expect(403);
        await http().post(url(t.id, '/solicitar')).set(supervisor()).send({}).expect(201);
        const a = ids(await herramientas(t.id))[0];
        await http()
          .post(url(t.id, `/${a}/preparar`))
          .set(supervisor())
          .send({})
          .expect(403);
        await http()
          .post(url(t.id, `/${a}/enviar`))
          .set(supervisor())
          .expect(403);
        await http()
          .get('/api/operaciones/fcr/herramientas/pendientes-de-bodega')
          .set(supervisor())
          .expect(403);
        await http()
          .post(url(t.id, `/${a}/preparar`))
          .set(bodega())
          .send({})
          .expect(201);
        await http()
          .post(url(t.id, `/${a}/enviar`))
          .set(bodega())
          .expect(201);
        await http()
          .post(url(t.id, `/${a}/recibir`))
          .set(bodega())
          .send({})
          .expect(403);
        await http()
          .post(url(t.id, `/${a}/recibir`))
          .set(otroSupervisor())
          .send({})
          .expect(403);
      });

      it('para salir de la preparación hay que confirmar el listado y recibir todas las herramientas; confirmado, no se agrega ni se quita', async () => {
        const t = await enPreparacion();
        const falta = await avanzar(t.id, 'asignacion').expect(409);
        expect(falta.body.code).toBe('REQUISITOS_PENDIENTES');
        expect(que(falta)).toMatch(/Herramientas recibidas/);
        expect(que(falta)).toMatch(/Listado de herramientas confirmado/);
        await http().post(url(t.id, '/solicitar')).set(supervisor()).send({}).expect(201);
        for (const id of ids(await herramientas(t.id))) {
          await http()
            .post(url(t.id, `/${id}/preparar`))
            .set(bodega())
            .send({})
            .expect(201);
          await http()
            .post(url(t.id, `/${id}/enviar`))
            .set(bodega())
            .expect(201);
          await http()
            .post(url(t.id, `/${id}/recibir`))
            .set(supervisor())
            .send({})
            .expect(201);
        }
        // recibidas, pero falta confirmar el listado
        const solo = await avanzar(t.id, 'asignacion').expect(409);
        expect(que(solo)).toMatch(/Listado de herramientas confirmado/);
        expect(que(solo)).not.toMatch(/Herramientas recibidas/);
        const c = await http()
          .post(url(t.id, '/confirmar-listado'))
          .set(supervisor())
          .send({ confirmado: true })
          .expect(201);
        expect(c.body.listadoConfirmado).toBe(true);
        await http().post(url(t.id)).set(supervisor()).send({ articuloId: CANASTA.id }).expect(409);
        // deshacer la confirmación permite cambiar y la vuelve a exigir
        await http()
          .post(url(t.id, '/confirmar-listado'))
          .set(supervisor())
          .send({ confirmado: false })
          .expect(201);
        const nueva = await http()
          .post(url(t.id))
          .set(supervisor())
          .send({ articuloId: CANASTA.id })
          .expect(201);
        // la nueva herramienta, sin recibir, vuelve a bloquear la salida
        const otra = await avanzar(t.id, 'asignacion').expect(409);
        expect(que(otra)).toMatch(/Herramientas recibidas/);
        expect(que(otra)).toMatch(/Listado de herramientas confirmado/);
        const cana = nueva.body.herramientas.find(
          (h: { articuloId: string }) => h.articuloId === CANASTA.id,
        );
        await http()
          .delete(url(t.id, `/${cana.id}`))
          .set(supervisor())
          .expect(200);
        await http()
          .post(url(t.id, '/confirmar-listado'))
          .set(supervisor())
          .send({ confirmado: true })
          .expect(201);
        const ok = await avanzar(t.id, 'asignacion').expect(201);
        expect(ok.body.paso.codigo).toBe('asignacion');
        // fuera de la preparación ya no se solicita, recibe, confirma ni recarga
        await http().post(url(t.id, '/solicitar')).set(supervisor()).send({}).expect(409);
        await http().post(url(t.id, '/recargar')).set(supervisor()).expect(409);
        await http()
          .post(url(t.id, '/confirmar-listado'))
          .set(supervisor())
          .send({ confirmado: false })
          .expect(409);
        // pero una herramienta que se necesita después (una dañada a sustituir) sí se agrega, marcada como tarde
        const tarde = await http()
          .post(url(t.id))
          .set(supervisor())
          .send({ articuloId: CANASTA.id })
          .expect(201);
        expect(
          tarde.body.herramientas.find((h: { articuloId: string }) => h.articuloId === CANASTA.id)
            .agregadaTarde,
        ).toBe(true);
      });

      it('un ticket sin herramientas por pedir puede salir de la preparación con solo confirmar el listado', async () => {
        const t = await crear({ lineas: [] });
        await avanzar(t.id, 'preparacion_herramientas').expect(201);
        await http().post(url(t.id, '/solicitar')).set(supervisor()).send({}).expect(409);
        await http()
          .post(url(t.id, '/confirmar-listado'))
          .set(supervisor())
          .send({ confirmado: true })
          .expect(201);
        await avanzar(t.id, 'asignacion').expect(201);
      });

      it('un ticket cerrado solo se consulta', async () => {
        // un ticket cerrado se inserta ya cerrado (la base no deja saltar de paso con un UPDATE)
        const id = uuidv7();
        const pedidoId = uuidv7();
        pedidos.push(pedidoId);
        await admin.query(
          "INSERT INTO fcr.ticket (id, pedido_id, pedido_codigo, paso_codigo, tipo_ot) VALUES ($1, $2, 'PED-CERRADO', 'cerrado', 'venta')",
          [id, pedidoId],
        );
        await http().post(url(id)).set(supervisor()).send({ articuloId: CANASTA.id }).expect(409);
        expect((await herramientas(id)).herramientas).toEqual([]);
      });
    });
    describe('reglas de la base de datos de las herramientas', () => {
      const rechaza = (sql: string, params: unknown[], patron: RegExp, pool = admin) =>
        expect(pool.query(sql, params)).rejects.toThrow(patron);
      const una = async () => {
        const t = await enPreparacion();
        const h = await prisma.ticketHerramienta.findFirstOrThrow({ where: { ticketId: t.id } });
        return { t, h };
      };

      it('el recorrido va en orden y cada marca lleva quién y cuándo (CHECK)', async () => {
        const { h } = await una();
        await rechaza(
          'UPDATE fcr.ticket_herramienta SET preparada_at = now(), preparada_por = $2 WHERE id = $1',
          [h.id, BODEGUERO.id],
          /ticket_herramienta_orden_check/,
        );
        await rechaza(
          'UPDATE fcr.ticket_herramienta SET solicitada_at = now() WHERE id = $1',
          [h.id],
          /ticket_herramienta_solicitada_check/,
        );
        await admin.query(
          'UPDATE fcr.ticket_herramienta SET solicitada_at = now(), solicitada_por = $2 WHERE id = $1',
          [h.id, SUPERVISOR.id],
        );
        await rechaza(
          'UPDATE fcr.ticket_herramienta SET recibida_at = now(), recibida_por = $2 WHERE id = $1',
          [h.id, SUPERVISOR.id],
          /ticket_herramienta_orden_check/,
        );
        await rechaza(
          'UPDATE fcr.ticket_herramienta SET faltante_at = now(), faltante_por = $2 WHERE id = $1',
          [h.id, SUPERVISOR.id],
          /ticket_herramienta_faltante_(causa_)?check/,
        );
        await rechaza(
          "UPDATE fcr.ticket_herramienta SET faltante_at = now(), faltante_por = $2, faltante_motivo = 'x', faltante_causa = 'perdida' WHERE id = $1",
          [h.id, SUPERVISOR.id],
          /ticket_herramienta_orden_check/,
        );
      });

      it('una marca con novedad no convive con la marca de ese paso; los textos no pueden ir vacíos', async () => {
        const { h } = await una();
        await admin.query(
          'UPDATE fcr.ticket_herramienta SET solicitada_at = now(), solicitada_por = $2 WHERE id = $1',
          [h.id, SUPERVISOR.id],
        );
        await rechaza(
          "UPDATE fcr.ticket_herramienta SET preparada_at = now(), preparada_por = $2, bodega_novedad = 'x' WHERE id = $1",
          [h.id, BODEGUERO.id],
          /ticket_herramienta_novedad_check/,
        );
        await rechaza(
          "UPDATE fcr.ticket_herramienta SET bodega_novedad = '   ' WHERE id = $1",
          [h.id],
          /ticket_herramienta_texto_check/,
        );
      });

      it('la herramienta de un kit viene de una línea del pedido, la manual no; la manual siempre tiene autor', async () => {
        const { t } = await una();
        await rechaza(
          "INSERT INTO fcr.ticket_herramienta (id, ticket_id, articulo_id, origen) VALUES ($1, $2, $3, 'pedido')",
          [uuidv7(), t.id, CEPILLO.id],
          /ticket_herramienta_origen_check/,
        );
        await rechaza(
          "INSERT INTO fcr.ticket_herramienta (id, ticket_id, articulo_id, origen, codigo_pedido, created_by, updated_by) VALUES ($1, $2, $3, 'manual', 'X', $4, $4)",
          [uuidv7(), t.id, CEPILLO.id, SUPERVISOR.id],
          /ticket_herramienta_origen_check/,
        );
        await rechaza(
          "INSERT INTO fcr.ticket_herramienta (id, ticket_id, articulo_id, origen) VALUES ($1, $2, $3, 'manual')",
          [uuidv7(), t.id, CEPILLO.id],
          /ticket_herramienta_autor_check/,
        );
      });

      it('solo artículos de herramientas activos pueden ser herramienta de un ticket (disparador)', async () => {
        const { t } = await una();
        await rechaza(
          "INSERT INTO fcr.ticket_herramienta (id, ticket_id, articulo_id, origen, created_by, updated_by) VALUES ($1, $2, $3, 'manual', $4, $4)",
          [uuidv7(), t.id, QUIMICO.id, SUPERVISOR.id],
          /no es una herramienta activa/,
        );
        await rechaza(
          "INSERT INTO fcr.ticket_herramienta (id, ticket_id, articulo_id, origen, created_by, updated_by) VALUES ($1, $2, $3, 'manual', $4, $4)",
          [uuidv7(), t.id, uuidv7(), SUPERVISOR.id],
          /no es una herramienta activa/,
        );
      });

      it('la historia de las herramientas es inmutable y una herramienta con historia no se puede borrar', async () => {
        const t = await enPreparacion();
        await http().post(url(t.id, '/solicitar')).set(supervisor()).send({}).expect(201);
        const h = await prisma.ticketHerramienta.findFirstOrThrow({ where: { ticketId: t.id } });
        const e = await prisma.ticketHerramientaEvento.findFirstOrThrow({
          where: { herramientaId: h.id },
        });
        await rechaza(
          "UPDATE fcr.ticket_herramienta_evento SET detalle = 'cambiado' WHERE id = $1",
          [e.id],
          /permission denied/,
          appPool,
        );
        await rechaza(
          'DELETE FROM fcr.ticket_herramienta_evento WHERE id = $1',
          [e.id],
          /permission denied/,
          appPool,
        );
        await rechaza(
          'DELETE FROM fcr.ticket_herramienta WHERE id = $1',
          [h.id],
          /ticket_herramienta_evento_herramienta_fkey/,
          appPool,
        );
        // los eventos que explican algo lo explican
        await rechaza(
          "INSERT INTO fcr.ticket_herramienta_evento (id, herramienta_id, tipo, actor_id) VALUES ($1, $2, 'faltante', $3)",
          [uuidv7(), h.id, SUPERVISOR.id],
          /ticket_herramienta_evento_novedad_check/,
        );
        await rechaza(
          "INSERT INTO fcr.ticket_herramienta_evento (id, herramienta_id, tipo, actor_id) VALUES ($1, $2, 'enviada', $3)",
          [uuidv7(), h.id, uuidv7()],
          /ticket_herramienta_evento_actor_fkey/,
        );
      });

      it('las líneas y los avisos de la precarga: cantidad positiva, un orden por línea y artículo solo en el aviso de artículo inactivo', async () => {
        const t = await enPreparacion();
        await rechaza(
          "INSERT INTO fcr.ticket_linea (id, ticket_id, orden, codigo, descripcion, unidad, cantidad, tipo_linea) VALUES ($1, $2, 1, 'X', 'X', 'u', 1, 'servicio')",
          [uuidv7(), t.id],
          /ticket_linea_orden_key/,
        );
        await rechaza(
          "INSERT INTO fcr.ticket_linea (id, ticket_id, orden, codigo, descripcion, unidad, cantidad, tipo_linea) VALUES ($1, $2, 99, 'X', 'X', 'u', 0, 'servicio')",
          [uuidv7(), t.id],
          /ticket_linea_cantidad_check/,
        );
        await rechaza(
          "INSERT INTO fcr.ticket_aviso_precarga (id, ticket_id, motivo, articulo_id) VALUES ($1, $2, 'kit_vacio', $3)",
          [uuidv7(), t.id, CEPILLO.id],
          /ticket_aviso_precarga_articulo_check/,
        );
        await rechaza(
          "INSERT INTO fcr.ticket_aviso_precarga (id, ticket_id, motivo) VALUES ($1, $2, 'articulo_inactivo')",
          [uuidv7(), t.id],
          /ticket_aviso_precarga_articulo_check/,
        );
      });

      it('las unidades de cotización: de tiempo, solo día, hora, semana y mes; el código no se repite', async () => {
        const filas = await prisma.unidadCotizacion.findMany({ where: { esTiempo: true } });
        expect(filas.map((u) => u.codigo).sort()).toEqual(['dia', 'hora', 'mes', 'semana']);
        await rechaza(
          "INSERT INTO fcr.unidad_cotizacion (id, codigo, nombre, orden) VALUES ($1, 'dia', 'Otro', 99)",
          [uuidv7()],
          /unidad_cotizacion_codigo_key/,
        );
      });
    });
  },
);
