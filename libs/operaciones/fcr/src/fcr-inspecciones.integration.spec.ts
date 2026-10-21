/**
 * Integración real de la inspección de herramientas de FCR (F3): partes copiadas del artículo, resultados, tres firmas en orden,
 * envío, aprobación o rechazo (versión nueva) y documentos del ticket. Postgres real; sin RabbitMQ.
 *   RUN_INTEGRATION=1 npx jest fcr-inspecciones
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
const OTRO_SUPERVISOR = u('Saúl Supervisor', 'supervisor');
const SUP_OPS = u('Sofía Supervisora de Operaciones', 'supervisor_operaciones_fcr');
const INSPECTOR = u('Iván Inspector', 'operador_fcr');
const OTRO_OPERADOR = u('Omar Operador', 'operador_fcr');
const HSE = u('Hugo Técnico HSE', 'tecnico_hse');
const GERENTE_HSE = u('Gema Gerente HSE', 'gerente_hse');
const VENTAS = u('Vera Ventas', 'ingenieria_ventas');
const CLIENTE = { id: uuidv7(), nombre: `Cliente IN ${n}`, ruc: `84${String(n).slice(-11)}` };
const CAMPO = { id: uuidv7(), nombre: `SACHA IN ${n}` };
const BLOQUE = { id: uuidv7(), nombre: `Bloque IN ${n}` };
const POZO = { id: uuidv7(), nombre: `IN-POZO-${n}`, campoId: CAMPO.id, bloqueId: BLOQUE.id };
const CAT = uuidv7();
const CAT_OTRA = uuidv7();
const art = (s: string) => ({ id: uuidv7(), codigo: `IN-${s}-${n}` });
const CEPILLO = art('CEP');
const MAGNETO = art('MAG');
const PARTES = [uuidv7(), uuidv7(), uuidv7()];
const MAESTROS: MaestrosDePrueba = {
  usuarios: [
    SUPERVISOR,
    OTRO_SUPERVISOR,
    SUP_OPS,
    INSPECTOR,
    OTRO_OPERADOR,
    HSE,
    GERENTE_HSE,
    VENTAS,
  ],
  clientes: [CLIENTE],
  campos: [CAMPO],
  bloques: [BLOQUE],
  pozos: [POZO],
};

run(
  'FCR: inspección y reparación de herramientas, aprobación y documentos (base de datos real)',
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
    const supOps = () => tok(SUP_OPS);
    const inspector = () => tok(INSPECTOR);
    const ventas = () => tok(VENTAS, [P.FCR_VER, P.FCR_CONFIGURACION_GESTIONAR]);

    const pedidos: string[] = [];
    const eventos: string[] = [];
    let seq = 500_000 + (n % 100_000) * 10;
    let cods = 0;
    const q = (r: { body: { detail?: string; message?: string } }) =>
      String(r.body.detail ?? r.body.message);
    const base = (t: string) => `/api/operaciones/fcr/tickets/${t}`;

    const abierto = (lineas: unknown[], tipoOt = 'servicio') => {
      const pedidoId = uuidv7();
      pedidos.push(pedidoId);
      const id = uuidv7();
      eventos.push(id);
      return {
        id,
        type: 'comercial.pedido.abierto',
        version: 1,
        occurredAt: '2026-11-02T10:00:00.000Z',
        source: 'comercial',
        subject: { type: 'pedido', id: pedidoId },
        data: {
          codigo: `PED-IN${n}`,
          lineaServicio: 'fcr',
          tipoOt,
          tiposServicio: ['pesca'],
          ticketNumero: seq++,
          clienteId: CLIENTE.id,
          campoId: CAMPO.id,
          bloqueId: BLOQUE.id,
          pozoId: POZO.id,
          rigless: false,
          fechaInicioServicio: '2026-11-05',
          fechaFinServicio: '2026-11-12',
          lineas,
        },
      } as EventEnvelope;
    };

    /** Ticket de servicios en el paso de inspección con dos herramientas del pedido (un cepillo con 3 partes y un magneto sin partes). */
    const enInspeccion = async (tipoOt = 'servicio') => {
      const codigo = `SH-IN-${n}-${cods++}`;
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
      const e = abierto(
        [
          {
            codigo,
            descripcion: 'Sarta',
            unidad: 'Corrida',
            cantidad: 1,
            tipoLinea: 'herramienta',
          },
        ],
        tipoOt,
      );
      await consumer.consumir(e);
      const t = await prisma.ticket.findUniqueOrThrow({ where: { pedidoId: e.subject.id } });
      if (tipoOt === 'servicio') {
        const tipo = await prisma.tipoOperador.findUniqueOrThrow({ where: { codigo: 'mecanico' } });
        await http()
          .post(`${base(t.id)}/tipo-operador`)
          .set(supervisor())
          .send({ tipoOperadorId: tipo.id, inspectorId: INSPECTOR.id })
          .expect(201);
        await http()
          .post(`${base(t.id)}/avanzar`)
          .set(supervisor())
          .send({ hacia: 'inspeccion' })
          .expect(201);
      }
      const herr = await prisma.ticketHerramienta.findMany({
        where: { ticketId: t.id },
        include: { articulo: true },
      });
      return {
        id: t.id,
        cepillo: herr.find((h) => h.articuloId === CEPILLO.id)!.id,
        magneto: herr.find((h) => h.articuloId === MAGNETO.id)!.id,
      };
    };
    const iniciar = async (t: string, h: string, auth = inspector()) =>
      (
        await http()
          .post(`${base(t)}/herramientas/${h}/inspeccion`)
          .set(auth)
          .expect(201)
      ).body;
    const firmar = (t: string, i: string, rol: string, auth = inspector()) =>
      http()
        .post(`${base(t)}/inspecciones/${i}/firmas/${rol}`)
        .set(auth);
    const completar = async (t: string, i: string) => {
      await http()
        .put(`${base(t)}/inspecciones/${i}`)
        .set(inspector())
        .send({ inspeccionadoPor: 'dynadrill', reparadoPor: 'dynadrill' })
        .expect(200);
      await firmar(t, i, 'reparado_por').expect(201);
      await firmar(t, i, 'revisado_por', supervisor()).expect(201);
      await firmar(t, i, 'liberado_qhse', tok(HSE)).expect(201);
      return (
        await http()
          .post(`${base(t)}/inspecciones/${i}/enviar`)
          .set(inspector())
          .expect(201)
      ).body;
    };
    /** Las dos herramientas inspeccionadas y enviadas, y el formulario externo adjunto: el ticket puede pasar a la aprobación. */
    const listoParaAprobar = async () => {
      const t = await enInspeccion();
      const a = await iniciar(t.id, t.cepillo);
      const b = await iniciar(t.id, t.magneto);
      await completar(t.id, a.id);
      await completar(t.id, b.id);
      expect((await adjuntarFormulario(t.id)).status).toBe(201);
      await http()
        .post(`${base(t.id)}/avanzar`)
        .set(inspector())
        .send({ hacia: 'aprobacion_supervisor_operaciones' })
        .expect(201);
      return { ...t, a: a.id, b: b.id };
    };
    const archivo = async (modulo = 'ticket_fcr_documento') => {
      const id = uuidv7();
      await admin.query(
        `INSERT INTO archivos.archivo (id, modulo_id, nombre_original, mime_type, tamano_bytes, sha256, blob_key, escaneo, subido_por)
       SELECT $1::uuid, mo.id, 'form.pdf', 'application/pdf', 10, repeat('c', 64), 'prueba/' || $1::text, 'omitido', $2::uuid
         FROM archivos.modulo_archivo mo WHERE mo.codigo = $3`,
        [id, INSPECTOR.id, modulo],
      );
      return id;
    };
    let t0 = '';
    const adjuntarFormulario = (
      t = t0,
      auth = inspector(),
      campo = 'formulario_inspeccion_externo',
    ) =>
      archivo().then((archivoId) =>
        http()
          .post(`${base(t)}/documentos`)
          .set(auth)
          .send({ campo, archivoId }),
      );

    beforeAll(async () => {
      await sembrarMaestros(admin, MAESTROS);
      await admin.query(
        'INSERT INTO inventario.categoria_articulo (id, nombre, lleva_partes) VALUES ($1, $2, true), ($3, $4, false)',
        [CAT, `CAT-HERR-IN ${n}`, CAT_OTRA, `CAT-OTRA-IN ${n}`],
      );
      for (const a of [CEPILLO, MAGNETO]) {
        await admin.query(
          `INSERT INTO inventario.articulo (id, codigo, nombre, categoria_id, unidad_stock_id)
         VALUES ($1, $2, $3, $4, (SELECT id FROM inventario.unidad_stock ORDER BY nombre LIMIT 1))`,
          [a.id, a.codigo, `Herramienta ${a.codigo}`, CAT],
        );
      }
      for (const [i, id] of PARTES.entries()) {
        await admin.query(
          `INSERT INTO inventario.articulo_parte (id, articulo_id, orden, item, codigo, descripcion, cantidad_esperada)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [id, CEPILLO.id, i + 1, String(i + 1), `P-${n}-${i + 1}`, `Parte ${i + 1}`, i + 1],
        );
      }
      Object.assign(process.env, {
        SERVICE_NAME: 'operaciones-test',
        PORT: '3199',
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
    });

    afterAll(async () => {
      const h =
        '(SELECT id FROM fcr.ticket_herramienta WHERE ticket_id IN (SELECT id FROM fcr.ticket WHERE pedido_id = ANY($1::uuid[])))';
      if (pedidos.length) {
        const i = `(SELECT id FROM fcr.inspeccion_herramienta WHERE herramienta_id IN ${h})`;
        await admin.query(`DELETE FROM fcr.inspeccion_firma WHERE inspeccion_id IN ${i}`, [
          pedidos,
        ]);
        // el disparador protege las partes copiadas: la limpieza lo apaga dentro de una transacción (nadie más lo ve apagado)
        const c = await admin.connect();
        try {
          await c.query('BEGIN');
          await c.query(
            'ALTER TABLE fcr.inspeccion_parte DISABLE TRIGGER inspeccion_parte_protegida',
          );
          await c.query(`DELETE FROM fcr.inspeccion_parte WHERE inspeccion_id IN ${i}`, [pedidos]);
          await c.query(
            'ALTER TABLE fcr.inspeccion_parte ENABLE TRIGGER inspeccion_parte_protegida',
          );
          await c.query('COMMIT');
        } catch (e) {
          await c.query('ROLLBACK');
          throw e;
        } finally {
          c.release();
        }
        await admin.query(`DELETE FROM fcr.inspeccion_herramienta WHERE herramienta_id IN ${h}`, [
          pedidos,
        ]);
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
      await admin.query(
        "DELETE FROM archivos.archivo WHERE blob_key LIKE 'prueba/%' AND nombre_original = 'form.pdf' AND subido_por = $1",
        [INSPECTOR.id],
      );
      if (eventos.length)
        await admin.query('DELETE FROM msg_operaciones.inbox WHERE id = ANY($1::uuid[])', [
          eventos,
        ]);
      await admin.query('DELETE FROM inventario.articulo_parte WHERE articulo_id = $1', [
        CEPILLO.id,
      ]);
      await admin.query('DELETE FROM inventario.articulo WHERE categoria_id = ANY($1::uuid[])', [
        [CAT, CAT_OTRA],
      ]);
      await admin.query('DELETE FROM inventario.categoria_articulo WHERE id = ANY($1::uuid[])', [
        [CAT, CAT_OTRA],
      ]);
      await quitarMaestros(admin, MAESTROS);
      await admin.end();
      await appPool.end();
      await app.close();
    });

    describe('iniciar y llenar la inspección', () => {
      it('copia las partes del artículo al iniciar; es idempotente y un cambio posterior al catálogo no la altera', async () => {
        const t = await enInspeccion();
        const i = await iniciar(t.id, t.cepillo);
        expect(i).toMatchObject({
          estado: 'borrador',
          version: 1,
          cliente: CLIENTE.nombre,
          pozo: POZO.nombre,
          codigoHerramienta: CEPILLO.codigo,
          numeroSerie: null,
        });
        expect(
          i.partes.map((p: { descripcion: string; cantidadEsperada: number; manual: boolean }) => [
            p.descripcion,
            p.cantidadEsperada,
            p.manual,
          ]),
        ).toEqual([
          ['Parte 1', 1, false],
          ['Parte 2', 2, false],
          ['Parte 3', 3, false],
        ]);
        expect(i.fechaInspeccion).toBe(new Date().toISOString().slice(0, 10));
        const otra = await iniciar(t.id, t.cepillo);
        expect(otra.id).toBe(i.id);
        // el catálogo cambia: la inspección iniciada conserva su copia
        await admin.query(
          "UPDATE inventario.articulo_parte SET descripcion = 'CAMBIADA', cantidad_esperada = 9 WHERE id = $1",
          [PARTES[0]],
        );
        await admin.query(
          "INSERT INTO inventario.articulo_parte (id, articulo_id, orden, item, codigo, descripcion) VALUES ($1, $2, 4, '4', 'X', 'Nueva')",
          [uuidv7(), CEPILLO.id],
        );
        try {
          const vista = (
            await http()
              .get(`${base(t.id)}/inspecciones/${i.id}`)
              .set(inspector())
              .expect(200)
          ).body;
          expect(vista.partes).toHaveLength(3);
          expect(vista.partes[0]).toMatchObject({ descripcion: 'Parte 1', cantidadEsperada: 1 });
        } finally {
          await admin.query(
            "UPDATE inventario.articulo_parte SET descripcion = 'Parte 1', cantidad_esperada = 1 WHERE id = $1",
            [PARTES[0]],
          );
          await admin.query(
            'DELETE FROM inventario.articulo_parte WHERE articulo_id = $1 AND orden = 4',
            [CEPILLO.id],
          );
        }
        // una herramienta sin partes empieza sin partes
        expect((await iniciar(t.id, t.magneto)).partes).toEqual([]);
        const lista = (
          await http()
            .get(`${base(t.id)}/inspecciones`)
            .set(inspector())
            .expect(200)
        ).body;
        expect(lista.map((x: { inspeccion: { estado: string } }) => x.inspeccion.estado)).toEqual([
          'borrador',
          'borrador',
        ]);
      });

      it('solo el operador asignado a la inspección actúa, en el paso de inspección y en tickets de servicios', async () => {
        const t = await enInspeccion();
        await http()
          .post(`${base(t.id)}/herramientas/${t.cepillo}/inspeccion`)
          .set(supervisor())
          .expect(403);
        await http()
          .post(`${base(t.id)}/herramientas/${t.cepillo}/inspeccion`)
          .set(tok(OTRO_OPERADOR))
          .expect(403);
        await http()
          .post(`${base(t.id)}/herramientas/${uuidv7()}/inspeccion`)
          .set(inspector())
          .expect(404);
        const venta = await enInspeccion('venta');
        await http()
          .post(`${base(venta.id)}/herramientas/${venta.cepillo}/inspeccion`)
          .set(inspector())
          .expect(409);
        // y la base lo exige aunque el servicio fallara
        await expect(
          admin.query(
            'INSERT INTO fcr.inspeccion_herramienta (id, herramienta_id, created_by, updated_by) VALUES ($1, $2, $3, $3)',
            [uuidv7(), venta.cepillo, INSPECTOR.id],
          ),
        ).rejects.toThrow(/Solo se inspeccionan las herramientas de los tickets de servicios/);
      });

      it('guarda cabecera, resultados y partes a mano; solo las manuales se quitan; las fechas y valores se validan', async () => {
        const t = await enInspeccion();
        const i = await iniciar(t.id, t.cepillo);
        const url = `${base(t.id)}/inspecciones/${i.id}`;
        const r = await http()
          .put(url)
          .set(inspector())
          .send({
            inspeccionadoPor: 'proveedor_externo',
            reparadoPor: 'dynadrill',
            observaciones: 'Rosca gastada',
            numeroSerie: 'SN-77',
            fechaEnvio: '2026-11-06',
          })
          .expect(200);
        expect(r.body).toMatchObject({
          inspeccionadoPor: 'proveedor_externo',
          reparadoPor: 'dynadrill',
          observaciones: 'Rosca gastada',
          numeroSerie: 'SN-77',
          fechaEnvio: '2026-11-06',
        });
        await http().put(url).set(inspector()).send({ fechaInspeccion: '2026-02-31' }).expect(400);
        await http().put(url).set(inspector()).send({ inspeccionadoPor: 'otro' }).expect(400);
        const parte = r.body.partes[0];
        const p = await http()
          .put(`${url}/partes/${parte.id}`)
          .set(inspector())
          .send({ visual: 'ok', endResultado: 'defectuoso', cambioCantidad: 2, accion: 'Cambiar' })
          .expect(200);
        expect(p.body.partes[0]).toMatchObject({
          visual: 'ok',
          endResultado: 'defectuoso',
          cambioCantidad: 2,
          accion: 'Cambiar',
        });
        await http()
          .put(`${url}/partes/${parte.id}`)
          .set(inspector())
          .send({ visual: 'regular' })
          .expect(400);
        await http()
          .put(`${url}/partes/${uuidv7()}`)
          .set(inspector())
          .send({ visual: 'ok' })
          .expect(404);
        // partes a mano
        await http().post(`${url}/partes`).set(inspector()).send({ descripcion: '  ' }).expect(400);
        const m = await http()
          .post(`${url}/partes`)
          .set(inspector())
          .send({ descripcion: 'Empaque extra', codigo: 'EMP-1', cantidadEsperada: 2 })
          .expect(201);
        const manual = m.body.partes.find((x: { manual: boolean }) => x.manual);
        expect(manual).toMatchObject({
          descripcion: 'Empaque extra',
          codigo: 'EMP-1',
          cantidadEsperada: 2,
          orden: 4,
          item: 'M4',
        });
        await http().delete(`${url}/partes/${parte.id}`).set(inspector()).expect(409);
        const q = await http().delete(`${url}/partes/${manual.id}`).set(inspector()).expect(200);
        expect(q.body.partes).toHaveLength(3);
        // el número de serie vive en la herramienta del ticket (una sola fuente)
        expect(
          (await prisma.ticketHerramienta.findUniqueOrThrow({ where: { id: t.cepillo } }))
            .numeroSerie,
        ).toBe('SN-77');
      });
    });

    describe('firmas y envío', () => {
      it('las firmas van en orden y por quien corresponde; «reparado por» bloquea los datos; con las tres se envía', async () => {
        const t = await enInspeccion();
        const i = await iniciar(t.id, t.cepillo);
        const url = `${base(t.id)}/inspecciones/${i.id}`;
        await firmar(t.id, i.id, 'revisado_por', supervisor()).expect(409); // falta «reparado por»
        await firmar(t.id, i.id, 'reparado_por').expect(400); // falta indicar quién inspeccionó y reparó
        await http()
          .put(url)
          .set(inspector())
          .send({ inspeccionadoPor: 'dynadrill', reparadoPor: 'dynadrill' })
          .expect(200);
        await firmar(t.id, i.id, 'reparado_por', supervisor()).expect(403);
        await firmar(t.id, i.id, 'reparado_por', tok(OTRO_OPERADOR)).expect(403);
        await firmar(t.id, i.id, 'inventada').expect(400);
        const f1 = await firmar(t.id, i.id, 'reparado_por').expect(201);
        expect(f1.body.firmas.reparado_por).toMatchObject({
          usuarioId: INSPECTOR.id,
          nombre: INSPECTOR.nombre,
        });
        expect(f1.body.fechaReparacion).toBe(new Date().toISOString().slice(0, 10));
        await firmar(t.id, i.id, 'reparado_por').expect(409);
        // los datos y las partes quedaron bloqueados
        await http().put(url).set(inspector()).send({ observaciones: 'tarde' }).expect(409);
        await http().post(`${url}/partes`).set(inspector()).send({ descripcion: 'x' }).expect(409);
        await http()
          .put(`${url}/partes/${i.partes[0].id}`)
          .set(inspector())
          .send({ visual: 'ok' })
          .expect(409);
        // «revisado por»: el Supervisor del ticket (no otro); «liberado por QHSE»: técnico o gerente HSE
        await firmar(t.id, i.id, 'revisado_por', tok(OTRO_SUPERVISOR)).expect(403);
        await firmar(t.id, i.id, 'liberado_qhse', tok(HSE)).expect(409);
        await firmar(t.id, i.id, 'revisado_por', supervisor()).expect(201);
        await http().post(`${url}/enviar`).set(inspector()).expect(409); // falta QHSE
        await firmar(t.id, i.id, 'liberado_qhse', supervisor()).expect(403);
        const f3 = await firmar(t.id, i.id, 'liberado_qhse', tok(GERENTE_HSE)).expect(201);
        expect(f3.body.firmas.liberado_qhse.nombre).toBe(GERENTE_HSE.nombre);
        const e = await http().post(`${url}/enviar`).set(inspector()).expect(201);
        expect(e.body).toMatchObject({ estado: 'enviada', enviadaPor: INSPECTOR.nombre });
        await http().post(`${url}/enviar`).set(inspector()).expect(409);
        await firmar(t.id, i.id, 'liberado_qhse', tok(HSE)).expect(409);
      });

      it('las inspecciones enviadas cumplen el requisito de todas las herramientas; una herramienta nueva lo reabre', async () => {
        const t = await enInspeccion();
        const estado = async () =>
          (
            await prisma.ticketRequisito.findFirstOrThrow({
              where: { ticketId: t.id, requisitoCodigo: 'inspecciones_enviadas' },
            })
          ).estado;
        expect(await estado()).toBe('pendiente');
        await completar(t.id, (await iniciar(t.id, t.cepillo)).id);
        expect(await estado()).toBe('pendiente'); // falta el magneto
        await completar(t.id, (await iniciar(t.id, t.magneto)).id);
        expect(await estado()).toBe('cumplido');
      });
    });

    describe('documentos y paso a la aprobación', () => {
      it('no pasa a la aprobación sin el formulario externo; lo adjunta el operador y el archivo debe ser de este módulo', async () => {
        const t = await enInspeccion();
        t0 = t.id;
        await completar(t.id, (await iniciar(t.id, t.cepillo)).id);
        await completar(t.id, (await iniciar(t.id, t.magneto)).id);
        const falta = await http()
          .post(`${base(t.id)}/avanzar`)
          .set(inspector())
          .send({ hacia: 'aprobacion_supervisor_operaciones' })
          .expect(409);
        expect(q(falta)).toMatch(/Formulario de inspección externo/);
        expect(q(falta)).not.toMatch(/Inspecciones de herramientas enviadas/);
        await adjuntarFormulario(t.id, supervisor()).then((r) => expect(r.status).toBe(403));
        const ajeno = await archivo('pedido_documento');
        await http()
          .post(`${base(t.id)}/documentos`)
          .set(inspector())
          .send({ campo: 'formulario_inspeccion_externo', archivoId: ajeno })
          .expect(400);
        await http()
          .post(`${base(t.id)}/documentos`)
          .set(inspector())
          .send({ campo: 'formulario_inspeccion_externo', archivoId: uuidv7() })
          .expect(400);
        await http()
          .post(`${base(t.id)}/documentos`)
          .set(inspector())
          .send({ campo: 'otro', archivoId: ajeno })
          .expect(400);
        // un documento del tronco no se adjunta en la inspección
        await adjuntarFormulario(t.id, inspector(), 'registro_dureza').then((r) =>
          expect(r.status).toBe(409),
        );
        const ok = await adjuntarFormulario(t.id);
        expect(ok.status).toBe(201);
        expect(ok.body).toEqual([
          expect.objectContaining({
            campo: 'formulario_inspeccion_externo',
            subidoPor: INSPECTOR.nombre,
          }),
        ]);
        const a = await http()
          .post(`${base(t.id)}/avanzar`)
          .set(inspector())
          .send({ hacia: 'aprobacion_supervisor_operaciones' })
          .expect(201);
        expect(a.body.paso.codigo).toBe('aprobacion_supervisor_operaciones');
        const aviso = await admin.query(
          "SELECT 1 FROM msg_operaciones.outbox WHERE tipo = 'operaciones.fcr.aprobacion_solicitada' AND datos->'data'->>'ticketId' = $1",
          [t.id],
        );
        expect(aviso.rowCount).toBe(1);
      });

      it('los documentos del tronco los adjunta el Supervisor del ticket en la preparación y la venta no lleva los de servicios', async () => {
        const v = await enInspeccion('venta');
        await http()
          .post(`${base(v.id)}/avanzar`)
          .set(supervisor())
          .send({ hacia: 'preparacion_herramientas' })
          .expect(201);
        const a1 = await archivo();
        const campo = 'registro_qaqc';
        await http()
          .post(`${base(v.id)}/documentos`)
          .set(tok(OTRO_SUPERVISOR))
          .send({ campo, archivoId: a1 })
          .expect(403);
        await http()
          .post(`${base(v.id)}/documentos`)
          .set(supervisor())
          .send({ campo, archivoId: a1 })
          .expect(201);
        // el mismo archivo no se adjunta dos veces; otro del mismo campo lo reemplaza como vigente
        const repetido = await http()
          .post(`${base(v.id)}/documentos`)
          .set(supervisor())
          .send({ campo, archivoId: a1 });
        expect(repetido.status).toBeGreaterThanOrEqual(400);
        const lista = await http()
          .post(`${base(v.id)}/documentos`)
          .set(supervisor())
          .send({ campo, archivoId: await archivo() })
          .expect(201);
        expect(lista.body.filter((d: { campo: string }) => d.campo === campo)).toHaveLength(2);
        await http()
          .post(`${base(v.id)}/documentos`)
          .set(supervisor())
          .send({ campo: 'formato_dureza_servicio', archivoId: await archivo() })
          .expect(409);
      });
    });

    describe('aprobar o rechazar', () => {
      it('el Supervisor de Operaciones aprueba: las inspecciones quedan aprobadas y el ticket entra a la preparación; el avance genérico no lo hace', async () => {
        const t = await listoParaAprobar();
        await http()
          .post(`${base(t.id)}/avanzar`)
          .set(supOps())
          .send({ hacia: 'preparacion_herramientas' })
          .expect(409);
        await http()
          .post(`${base(t.id)}/aprobar-inspecciones`)
          .set(supervisor())
          .expect(403);
        await http()
          .post(`${base(t.id)}/aprobar-inspecciones`)
          .set(inspector())
          .expect(403);
        const r = await http()
          .post(`${base(t.id)}/aprobar-inspecciones`)
          .set(supOps())
          .expect(201);
        expect(r.body.paso.codigo).toBe('preparacion_herramientas');
        const est = await prisma.inspeccionHerramienta.findMany({
          where: { herramienta: { ticketId: t.id } },
        });
        expect(est.map((x) => x.estado)).toEqual(['aprobada', 'aprobada']);
        expect(est[0].decididaPor).toBe(SUP_OPS.id);
        // fuera de la aprobación ya no se aprueba ni se rechaza
        await http()
          .post(`${base(t.id)}/aprobar-inspecciones`)
          .set(supOps())
          .expect(409);
        // y las dos entradas confluyen: sigue el tronco común
        await http()
          .post(`${base(t.id)}/herramientas/confirmar-listado`)
          .set(supervisor())
          .send({ confirmado: true })
          .expect(201);
      });

      it('rechazar exige motivo, devuelve el ticket a la inspección y la rechazada queda como historia: se rehace como versión nueva con lo registrado y sin firmas', async () => {
        const t = await listoParaAprobar();
        await http()
          .post(`${base(t.id)}/rechazar-inspecciones`)
          .set(supOps())
          .send({ motivo: 'x' })
          .expect(400);
        await http()
          .post(`${base(t.id)}/rechazar-inspecciones`)
          .set(supervisor())
          .send({ motivo: 'Falta el torque' })
          .expect(403);
        await http()
          .post(`${base(t.id)}/rechazar-inspecciones`)
          .set(supOps())
          .send({ motivo: 'Falta el torque', herramientaIds: [uuidv7()] })
          .expect(400);
        const r = await http()
          .post(`${base(t.id)}/rechazar-inspecciones`)
          .set(supOps())
          .send({ motivo: 'Falta el torque', herramientaIds: [t.cepillo] })
          .expect(201);
        expect(r.body.paso.codigo).toBe('inspeccion');
        const rechazo = r.body.historial[r.body.historial.length - 1];
        expect(rechazo).toMatchObject({ pasoNuevo: 'inspeccion', motivo: 'Falta el torque' });
        const lista = (
          await http()
            .get(`${base(t.id)}/inspecciones`)
            .set(inspector())
            .expect(200)
        ).body;
        expect(
          lista.find((x: { herramientaId: string }) => x.herramientaId === t.cepillo).inspeccion,
        ).toMatchObject({ estado: 'rechazada', motivoRechazo: 'Falta el torque' });
        expect(
          lista.find((x: { herramientaId: string }) => x.herramientaId === t.magneto).inspeccion
            .estado,
        ).toBe('enviada');
        // aviso al operador que inspecciona
        const aviso = await admin.query(
          "SELECT datos->'data' AS d FROM msg_operaciones.outbox WHERE tipo = 'operaciones.fcr.inspeccion_rechazada' AND datos->'data'->>'ticketId' = $1",
          [t.id],
        );
        expect(aviso.rows[0].d).toMatchObject({
          motivo: 'Falta el torque',
          cantidad: 1,
          asignados: [{ usuarioId: INSPECTOR.id, rolCodigo: 'operador' }],
        });
        // no sale de la inspección hasta rehacerla
        const bloquea = await http()
          .post(`${base(t.id)}/avanzar`)
          .set(inspector())
          .send({ hacia: 'aprobacion_supervisor_operaciones' })
          .expect(409);
        expect(q(bloquea)).toMatch(/Inspecciones de herramientas enviadas/);
        // la versión nueva copia lo registrado y no copia las firmas
        const v1 = await prisma.inspeccionHerramienta.findFirstOrThrow({
          where: { herramientaId: t.cepillo, version: 1 },
        });
        const v2 = await iniciar(t.id, t.cepillo);
        expect(v2).toMatchObject({
          version: 2,
          estado: 'borrador',
          inspeccionadoPor: 'dynadrill',
          reparadoPor: 'dynadrill',
        });
        expect(v2.firmas).toEqual({ reparado_por: null, revisado_por: null, liberado_qhse: null });
        expect(v2.partes).toHaveLength(3);
        expect(
          (await prisma.inspeccionHerramienta.findUniqueOrThrow({ where: { id: v2.id } }))
            .versionAnteriorId,
        ).toBe(v1.id);
        // la rechazada no se toca
        await expect(
          admin.query("UPDATE fcr.inspeccion_herramienta SET estado = 'aprobada' WHERE id = $1", [
            v1.id,
          ]),
        ).rejects.toThrow(/ya no cambia de estado/);
        await expect(
          admin.query("UPDATE fcr.inspeccion_parte SET visual = 'ok' WHERE inspeccion_id = $1", [
            v1.id,
          ]),
        ).rejects.toThrow(/firmada o enviada/);
        // rehecha y enviada, vuelve a la aprobación y se aprueba
        await completar(t.id, v2.id);
        await http()
          .post(`${base(t.id)}/avanzar`)
          .set(inspector())
          .send({ hacia: 'aprobacion_supervisor_operaciones' })
          .expect(201);
        await http()
          .post(`${base(t.id)}/aprobar-inspecciones`)
          .set(supOps())
          .expect(201);
        const finales = await prisma.inspeccionHerramienta.findMany({
          where: { herramienta: { ticketId: t.id } },
          orderBy: [{ herramientaId: 'asc' }, { version: 'asc' }],
        });
        expect(finales.map((x) => x.estado).sort()).toEqual(['aprobada', 'aprobada', 'rechazada']);
      });

      it('sin todas las inspecciones enviadas no hay nada que aprobar ni rechazar', async () => {
        const t = await enInspeccion();
        await http()
          .post(`${base(t.id)}/aprobar-inspecciones`)
          .set(supOps())
          .expect(409);
        await http()
          .post(`${base(t.id)}/rechazar-inspecciones`)
          .set(supOps())
          .send({ motivo: 'Sin enviar' })
          .expect(409);
      });
    });

    describe('reglas de la base de datos de la inspección', () => {
      const rechaza = (sql: string, params: unknown[], patron: RegExp, pool = admin) =>
        expect(pool.query(sql, params)).rejects.toThrow(patron);

      it('las firmas son inmutables, van en orden y las deja quien tiene el rol (disparadores y REVOKE)', async () => {
        const t = await enInspeccion();
        const i = await iniciar(t.id, t.cepillo);
        const ins = (rol: string, usuario: string) =>
          admin.query(
            'INSERT INTO fcr.inspeccion_firma (inspeccion_id, rol, usuario_id) VALUES ($1, $2, $3)',
            [i.id, rol, usuario],
          );
        await expect(ins('revisado_por', SUPERVISOR.id)).rejects.toThrow(/Primero debe firmarse/);
        await expect(ins('reparado_por', SUPERVISOR.id)).rejects.toThrow(
          /no tiene el rol que exige/,
        );
        await ins('reparado_por', INSPECTOR.id);
        await expect(ins('liberado_qhse', HSE.id)).rejects.toThrow(/Primero debe firmarse/);
        await expect(ins('reparado_por', INSPECTOR.id)).rejects.toThrow(/inspeccion_firma_pkey/);
        await rechaza(
          'UPDATE fcr.inspeccion_firma SET usuario_id = $2 WHERE inspeccion_id = $1',
          [i.id, OTRO_OPERADOR.id],
          /permission denied/,
          appPool,
        );
        await rechaza(
          'DELETE FROM fcr.inspeccion_firma WHERE inspeccion_id = $1',
          [i.id],
          /permission denied/,
          appPool,
        );
      });

      it('el estado y sus marcas van juntos, hay una sola inspección vigente por herramienta y una versión no se repite', async () => {
        const t = await enInspeccion();
        const i = await iniciar(t.id, t.cepillo);
        await rechaza(
          "UPDATE fcr.inspeccion_herramienta SET estado = 'enviada' WHERE id = $1",
          [i.id],
          /inspeccion_herramienta_estado_check/,
        );
        await rechaza(
          "UPDATE fcr.inspeccion_herramienta SET estado = 'rechazada', enviada_at = now(), enviada_por = $2, decidida_at = now(), decidida_por = $2 WHERE id = $1",
          [i.id, SUP_OPS.id],
          /inspeccion_herramienta_rechazo_check/,
        );
        await rechaza(
          'INSERT INTO fcr.inspeccion_herramienta (id, herramienta_id, version, created_by, updated_by) VALUES ($1, $2, 2, $3, $3)',
          [uuidv7(), t.cepillo, INSPECTOR.id],
          /inspeccion_herramienta_vigente_key/,
        );
        await rechaza(
          'INSERT INTO fcr.inspeccion_herramienta (id, herramienta_id, version, created_by, updated_by) VALUES ($1, $2, 1, $3, $3)',
          [uuidv7(), t.cepillo, INSPECTOR.id],
          /inspeccion_herramienta_version_key/,
        );
        await rechaza(
          'UPDATE fcr.inspeccion_herramienta SET version = 5 WHERE id = $1',
          [i.id],
          /no cambian/,
        );
        await rechaza(
          "UPDATE fcr.inspeccion_herramienta SET fecha_reparacion = '2000-01-01' WHERE id = $1",
          [i.id],
          /inspeccion_herramienta_fechas_check/,
        );
        await rechaza(
          "UPDATE fcr.inspeccion_herramienta SET observaciones = '  ' WHERE id = $1",
          [i.id],
          /inspeccion_herramienta_texto_check/,
        );
        // una herramienta con inspección no se borra: la historia firmada no se pierde
        await rechaza(
          'DELETE FROM fcr.ticket_herramienta WHERE id = $1',
          [t.cepillo],
          /inspeccion_herramienta_herramienta_fkey/,
        );
      });

      it('las partes: la copia no se edita, solo se borran las manuales, cantidades válidas; si Inventario da de baja la parte, la copia queda', async () => {
        const t = await enInspeccion();
        const i = await iniciar(t.id, t.cepillo);
        const copia = i.partes[0].id;
        await rechaza(
          "UPDATE fcr.inspeccion_parte SET descripcion = 'otra' WHERE id = $1",
          [copia],
          /no se edita/,
        );
        await rechaza(
          'DELETE FROM fcr.inspeccion_parte WHERE id = $1',
          [copia],
          /Solo se pueden quitar las partes agregadas a mano/,
        );
        await rechaza(
          'UPDATE fcr.inspeccion_parte SET cambio_cantidad = -1 WHERE id = $1',
          [copia],
          /inspeccion_parte_cantidad_check/,
        );
        await rechaza(
          'UPDATE fcr.inspeccion_parte SET manual = true WHERE id = $1',
          [copia],
          /inspeccion_parte_manual_check|no se edita/,
        );
        await rechaza(
          "UPDATE fcr.inspeccion_parte SET accion = '  ' WHERE id = $1",
          [copia],
          /inspeccion_parte_texto_check/,
        );
        await rechaza(
          "INSERT INTO fcr.inspeccion_parte (id, inspeccion_id, orden, item, descripcion, codigo) VALUES ($1, $2, 1, 'x', 'dup', 'c')",
          [uuidv7(), i.id],
          /inspeccion_parte_orden_key/,
        );
        await rechaza(
          "INSERT INTO fcr.inspeccion_parte (id, inspeccion_id, orden, item, descripcion) VALUES ($1, $2, 50, 'x', 'sin código')",
          [uuidv7(), i.id],
          /inspeccion_parte_codigo_check/,
        );
        // Inventario borra una parte del catálogo: la inspección conserva su copia
        const prestada = uuidv7();
        await admin.query(
          "INSERT INTO inventario.articulo_parte (id, articulo_id, orden, item, codigo, descripcion) VALUES ($1, $2, 10, '10', 'B', 'Baja')",
          [prestada, MAGNETO.id],
        );
        const j = await iniciar(t.id, t.magneto);
        expect(j.partes.map((p: { descripcion: string }) => p.descripcion)).toContain('Baja');
        try {
          await admin.query('DELETE FROM inventario.articulo_parte WHERE id = $1', [prestada]);
          const despues = await http()
            .get(`${base(t.id)}/inspecciones/${j.id}`)
            .set(inspector())
            .expect(200);
          expect(
            despues.body.partes.find((p: { descripcion: string }) => p.descripcion === 'Baja'),
          ).toMatchObject({
            manual: false,
            codigo: 'B',
          });
        } finally {
          await admin.query('DELETE FROM inventario.articulo_parte WHERE id = $1', [prestada]);
        }
      });

      it('un ticket solo cambia de paso por una transición del catálogo y los documentos solo enlazan archivos de FCR', async () => {
        const t = await enInspeccion();
        await rechaza(
          "UPDATE fcr.ticket SET paso_codigo = 'cerrado' WHERE id = $1",
          [t.id],
          /no puede pasar de/,
        );
        const ajeno = await archivo('pedido_documento');
        await rechaza(
          "INSERT INTO fcr.ticket_documento (id, ticket_id, campo, archivo_id, created_by) VALUES ($1, $2, 'registro_dureza', $3, $4)",
          [uuidv7(), t.id, ajeno, INSPECTOR.id],
          /no es un documento de FCR/,
        );
        const propio = await archivo();
        await admin.query(
          "INSERT INTO fcr.ticket_documento (id, ticket_id, campo, archivo_id, created_by) VALUES ($1, $2, 'registro_dureza', $3, $4)",
          [uuidv7(), t.id, propio, INSPECTOR.id],
        );
        await rechaza(
          "UPDATE fcr.ticket_documento SET campo = 'registro_qaqc' WHERE archivo_id = $1",
          [propio],
          /permission denied/,
          appPool,
        );
        await rechaza(
          'DELETE FROM fcr.ticket_documento WHERE archivo_id = $1',
          [propio],
          /permission denied/,
          appPool,
        );
        await admin.query(
          'UPDATE archivos.archivo SET eliminado_at = now(), eliminado_por = $2 WHERE id = $1',
          [propio, INSPECTOR.id],
        );
        await rechaza(
          "INSERT INTO fcr.ticket_documento (id, ticket_id, campo, archivo_id, created_by) VALUES ($1, $2, 'registro_qaqc', $3, $4)",
          [uuidv7(), t.id, propio, INSPECTOR.id],
          /no es un documento de FCR/,
        );
      });

      it('las firmas tienen sus roles en el catálogo y no se permite a un rol inventado', async () => {
        const filas = await admin.query(
          'SELECT rol_firma, rol_codigo FROM fcr.firma_rol_permitido ORDER BY rol_firma, rol_codigo',
        );
        expect(
          filas.rows.map(
            (r: { rol_firma: string; rol_codigo: string }) => `${r.rol_firma}:${r.rol_codigo}`,
          ),
        ).toEqual([
          'reparado_por:operador_fcr',
          'revisado_por:supervisor',
          'liberado_qhse:gerente_hse',
          'liberado_qhse:tecnico_hse',
        ]);
        await rechaza(
          "INSERT INTO fcr.firma_rol_permitido (rol_firma, rol_codigo) VALUES ('reparado_por', 'rol_inventado')",
          [],
          /firma_rol_permitido_rol_fkey/,
        );
      });
    });
  },
);
