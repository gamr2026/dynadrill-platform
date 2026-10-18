/**
 * Integración real de Inventario: Postgres (PgBouncer, app_operaciones). Crea sus propios maestros (cuentas, bodegas, categorías,
 * artículos) con nombres únicos por corrida y los borra al final.
 *   RUN_INTEGRATION=1 npx jest   (dentro de libs/operaciones/inventario)
 */
import { INestApplication, Module } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import request from 'supertest';
import { Permission, type RoleCode } from '@dyn/authz';
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
import { cargarDatosReales } from '../prisma/cargar-datos-reales';
import { cargarBienesAs2 } from '../prisma/cargar-bienes-as2';
import { cargarEpp } from '../prisma/cargar-epp';
import { cargarStockAs2 } from '../prisma/cargar-stock-as2';
import { normalizarCodigos } from '../prisma/normalizar-codigos';
import { sembrarCatalogos } from './catalog/sembrar-catalogos';
import { DespachosConsumer } from './consumers/despachos.consumer';
import { InventarioModule } from './inventario.module';
import { MovimientosService } from './services/movimientos.service';
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

const BODEGUERO = { id: uuidv7(), nombre: 'Berta Bodeguera', rol: 'bodeguero' };
const OPERADOR = { id: uuidv7(), nombre: 'Oscar Operador', rol: 'operador' };
const VENTAS = { id: uuidv7(), nombre: 'Vera Ventas', rol: 'ingenieria_ventas' };
const BODEGA_A = { id: uuidv7(), nombre: `Bodega IT-A ${n}` };
const BODEGA_B = { id: uuidv7(), nombre: `Bodega IT-B ${n}` };
const TICKET_A = uuidv7();
const TICKET_B = uuidv7();
const ARCHIVO_RESPALDO = uuidv7();
const ARCHIVO_MSDS = uuidv7();
const PEDIDO_DESPACHO = uuidv7();
const MAESTROS: MaestrosDePrueba = {
  usuarios: [BODEGUERO, OPERADOR, VENTAS],
  bodegas: [BODEGA_A, BODEGA_B],
};

/** Códigos que cargan después la carga inicial: el EPP y los bienes de AS2 (el recuento de la carga inicial no los cuenta). */
const cargasPosteriores = (): string[] => {
  const leer = (archivo: string) =>
    JSON.parse(readFileSync(join(__dirname, '..', 'prisma', 'data', archivo), 'utf8')) as {
      articulos: Array<{ codigo: string }>;
    };
  return [...leer('epp.json').articulos, ...leer('as2-bienes.json').articulos].map((a) => a.codigo);
};

run('Inventario: catálogo y kardex (base de datos real)', () => {
  jest.setTimeout(120000);
  let app: INestApplication;
  let prisma: PrismaService;
  let movimientosSvc: MovimientosService;
  let despachosConsumer: DespachosConsumer;
  const admin = new Pool({ connectionString: MIGRATOR_DB, max: 2 });
  const http = () => request(app.getHttpServer());
  const signer = new JwtService({
    privateKey,
    signOptions: { algorithm: 'RS256', issuer: 'dynadrill-plataforma', expiresIn: 600 },
  });
  const token = (roleCode: string, name: string, permissions: string[], sub: string) => ({
    Authorization: `Bearer ${signer.sign({ sub, email: `${roleCode}@test.local`, name, roleId: 'r', roleCode, permissions })}`,
  });
  const bodeguero = () =>
    token(
      'bodeguero',
      BODEGUERO.nombre,
      [
        P.ARTICULOS_VER,
        P.ARTICULOS_GESTIONAR,
        P.INVENTARIO_CONSUMIR,
        P.DESPACHOS_VER,
        P.DESPACHOS_GESTIONAR,
      ],
      BODEGUERO.id,
    );
  const lector = () => token('ingenieria_ventas', VENTAS.nombre, [P.ARTICULOS_VER], VENTAS.id);
  const sinPermisos = () => token('operador', OPERADOR.nombre, [], OPERADOR.id);

  const ids = {
    categoria: '',
    categoriaOtra: '',
    subcategoria: '',
    subcategoriaOtra: '',
    unidad: '',
    motivoCompra: '',
    motivoFaltante: '',
    motivoSobrante: '',
    motivoSaldoInicial: '',
    motivoSalidaTicket: '',
    motivoDevolucionTicket: '',
    motivoDespacho: '',
  };
  const articulos: string[] = [];
  const eventosEnviados: string[] = [];
  const categorias: string[] = [];

  const crearArticulo = async (sufijo: string) => {
    const dto = {
      codigo: `IT${n}${sufijo}`,
      nombre: `Artículo de prueba ${sufijo}`,
      categoriaId: ids.categoria,
      subcategoriaId: ids.subcategoria,
      unidadStockId: ids.unidad,
      costoUnitario: 12.3456,
      descuentoSugerido: 5,
    };
    const r = await http().post('/api/operaciones/inventario/articulos').set(bodeguero()).send(dto);
    expect(r.status).toBe(201);
    articulos.push(r.body.id);
    return r.body as { id: string; codigo: string };
  };
  const mover = (
    articuloId: string,
    bodegaId: string,
    motivoId: string,
    cantidad: number,
    extra: object = {},
  ) =>
    http()
      .post('/api/operaciones/inventario/movimientos')
      .set(bodeguero())
      .send({ articuloId, bodegaId, motivoId, cantidad, ...extra });
  const stockDe = async (articuloId: string) =>
    (await http().get(`/api/operaciones/inventario/stock?articuloId=${articuloId}`).set(lector()))
      .body;

  beforeAll(async () => {
    await sembrarMaestros(admin, MAESTROS);
    for (const t of [TICKET_A, TICKET_B]) {
      await admin.query(
        "INSERT INTO pumping.ticket (id, pedido_id, pedido_codigo, paso_codigo) VALUES ($1, $2, $3, 'revision_inicial')",
        [t, uuidv7(), `PED-INV${n}`],
      );
    }
    for (const a of [ARCHIVO_RESPALDO, ARCHIVO_MSDS]) {
      await admin.query(
        `INSERT INTO archivos.archivo (id, modulo_id, nombre_original, mime_type, tamano_bytes, sha256, blob_key, escaneo, subido_por)
         SELECT $1::uuid, mo.id, 'despacho.pdf', 'application/pdf', 10, repeat('a', 64), 'prueba/' || $1::text, 'omitido', $2::uuid
           FROM archivos.modulo_archivo mo WHERE mo.codigo = 'pedido_documento'`,
        [a, BODEGUERO.id],
      );
    }

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
        InventarioModule,
      ],
    })
    class TestAppModule {}
    const mod = await Test.createTestingModule({ imports: [TestAppModule] }).compile();
    app = mod.createNestApplication();
    configureApp(app, { corsOrigins: ['http://localhost:4200'] });
    // sin RabbitMQ: el receptor se invoca a mano; evitamos que intente suscribirse al arrancar
    jest.spyOn(DespachosConsumer.prototype, 'onApplicationBootstrap').mockResolvedValue(undefined);
    await app.init();
    prisma = app.get(PrismaService);
    movimientosSvc = app.get(MovimientosService);
    despachosConsumer = app.get(DespachosConsumer);

    // catálogos de la prueba
    await sembrarCatalogos(prisma);
    ids.unidad = (await prisma.unidadStock.findUniqueOrThrow({ where: { nombre: 'Galón' } })).id;
    const motivo = async (nombre: string) =>
      (await prisma.motivoMovimiento.findUniqueOrThrow({ where: { nombre } })).id;
    ids.motivoCompra = await motivo('Compra');
    ids.motivoFaltante = await motivo('Ajuste por conteo físico (faltante)');
    ids.motivoSobrante = await motivo('Ajuste por conteo físico (sobrante)');
    ids.motivoSaldoInicial = await motivo('Saldo inicial');
    ids.motivoSalidaTicket = await motivo('Salida para ticket');
    ids.motivoDevolucionTicket = await motivo('Devolución de ticket');
    ids.motivoDespacho = await motivo('Despacho a bodega de cliente');

    const cat = await http()
      .post('/api/operaciones/inventario/categorias')
      .set(bodeguero())
      .send({ nombre: `CAT-IT ${n}`, esQuimica: true });
    expect(cat.status).toBe(201);
    ids.categoria = cat.body.id;
    const cat2 = await http()
      .post('/api/operaciones/inventario/categorias')
      .set(bodeguero())
      .send({ nombre: `CAT-IT2 ${n}` });
    ids.categoriaOtra = cat2.body.id;
    categorias.push(ids.categoria, ids.categoriaOtra);
    const sub = await http()
      .post(`/api/operaciones/inventario/categorias/${ids.categoria}/subcategorias`)
      .set(bodeguero())
      .send({ nombre: `SUB-IT ${n}` });
    ids.subcategoria = sub.body.id;
    const sub2 = await http()
      .post(`/api/operaciones/inventario/categorias/${ids.categoriaOtra}/subcategorias`)
      .set(bodeguero())
      .send({ nombre: `SUB-IT2 ${n}` });
    ids.subcategoriaOtra = sub2.body.id;
  });

  afterAll(async () => {
    await admin.query(
      'DELETE FROM inventario.consumo_ticket WHERE ticket_pumping_id = ANY($1::uuid[])',
      [[TICKET_A, TICKET_B]],
    );
    if (articulos.length) {
      await admin.query('DELETE FROM inventario.movimiento WHERE articulo_id = ANY($1::uuid[])', [
        articulos,
      ]);
      await admin.query('DELETE FROM inventario.articulo WHERE id = ANY($1::uuid[])', [articulos]);
      await admin.query(
        "DELETE FROM msg_operaciones.outbox WHERE datos->'data'->>'articuloId' = ANY($1::text[])",
        [articulos],
      );
    }
    await admin.query(
      'DELETE FROM inventario.subcategoria_articulo WHERE categoria_id = ANY($1::uuid[])',
      [categorias],
    );
    await admin.query('DELETE FROM inventario.categoria_articulo WHERE id = ANY($1::uuid[])', [
      categorias,
    ]);
    await admin.query(
      'DELETE FROM inventario.movimiento WHERE despacho_id IN (SELECT id FROM inventario.despacho WHERE pedido_id = $1)',
      [PEDIDO_DESPACHO],
    );
    await admin.query('DELETE FROM inventario.despacho WHERE pedido_id = $1', [PEDIDO_DESPACHO]);
    await admin.query('DELETE FROM pumping.ticket WHERE id = ANY($1::uuid[])', [
      [TICKET_A, TICKET_B],
    ]);
    await admin.query('DELETE FROM archivos.archivo WHERE id = ANY($1::uuid[])', [
      [ARCHIVO_RESPALDO, ARCHIVO_MSDS],
    ]);
    await admin.query('DELETE FROM msg_operaciones.inbox WHERE id = ANY($1::uuid[])', [
      eventosEnviados,
    ]);
    await admin.query('DELETE FROM inventario.unidad_stock WHERE nombre LIKE $1', [`IT-%${n}`]);
    await quitarMaestros(admin, MAESTROS);
    await admin.end();
    await app.close();
  });

  describe('catálogo de artículos', () => {
    it('crea un artículo con nombres por JOIN, números y stock en cero; lo lee quien tiene `articulos.ver`', async () => {
      const a = await crearArticulo('A');
      const r = await http().get(`/api/operaciones/inventario/articulos/${a.id}`).set(lector());
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({
        codigo: `IT${n}A`,
        categoria: { id: ids.categoria, nombre: `CAT-IT ${n}`, esQuimica: true },
        subcategoria: { id: ids.subcategoria, nombre: `SUB-IT ${n}` },
        unidadStock: { nombre: 'Galón', simbolo: 'gal' },
        costoUnitario: 12.3456,
        descuentoSugerido: 5,
        activo: true,
        stockActual: 0,
        stockPorBodega: [],
      });
      const fila = await admin.query(
        'SELECT created_by, updated_by FROM inventario.articulo WHERE id = $1',
        [a.id],
      );
      expect(fila.rows[0]).toMatchObject({ created_by: BODEGUERO.id, updated_by: BODEGUERO.id });
    });

    it('rechaza un código repetido, una subcategoría de otra categoría y una unidad que no existe', async () => {
      const a = await crearArticulo('B');
      const base = { nombre: 'x', categoriaId: ids.categoria, unidadStockId: ids.unidad };
      const repetido = await http()
        .post('/api/operaciones/inventario/articulos')
        .set(bodeguero())
        .send({ ...base, codigo: a.codigo });
      expect(repetido.status).toBe(409);
      expect(repetido.body.code).toBe('CODIGO_DUPLICADO');
      const ajena = await http()
        .post('/api/operaciones/inventario/articulos')
        .set(bodeguero())
        .send({ ...base, codigo: `IT${n}Z1`, subcategoriaId: ids.subcategoriaOtra });
      expect(ajena.status).toBe(409);
      expect(ajena.body.code).toBe('SUBCATEGORIA_INVALIDA');
      const sinUnidad = await http()
        .post('/api/operaciones/inventario/articulos')
        .set(bodeguero())
        .send({ ...base, codigo: `IT${n}Z2`, unidadStockId: uuidv7() });
      expect(sinUnidad.status).toBe(409);
      expect(sinUnidad.body.code).toBe('UNIDAD_INVALIDA');
    });

    it('la base también garantiza que la subcategoría es de la categoría del artículo', async () => {
      const a = await crearArticulo('C');
      await expect(
        admin.query('UPDATE inventario.articulo SET subcategoria_id = $2 WHERE id = $1', [
          a.id,
          ids.subcategoriaOtra,
        ]),
      ).rejects.toThrow(/articulo_subcategoria_categoria_fkey/);
    });

    it('actualiza datos y códigos alternos (crear, cambiar y quitar); el código del artículo no cambia', async () => {
      const a = await crearArticulo('D');
      const r1 = await http()
        .put(`/api/operaciones/inventario/articulos/${a.id}`)
        .set(bodeguero())
        .send({
          nombre: 'Nombre nuevo',
          codigos: { alterno: 'ALT-1', barras: '7701234' },
          costoUnitario: null,
        });
      expect(r1.status).toBe(200);
      expect(r1.body).toMatchObject({
        nombre: 'Nombre nuevo',
        codigos: { alterno: 'ALT-1', comercial: null, barras: '7701234' },
        costoUnitario: null,
        subcategoria: { id: ids.subcategoria },
      });
      const r2 = await http()
        .put(`/api/operaciones/inventario/articulos/${a.id}`)
        .set(bodeguero())
        .send({ codigos: { alterno: '', comercial: 'COM-9' } });
      expect(r2.body.codigos).toEqual({ alterno: null, comercial: 'COM-9', barras: '7701234' });
      const cambioCodigo = await http()
        .put(`/api/operaciones/inventario/articulos/${a.id}`)
        .set(bodeguero())
        .send({ codigo: 'OTRO' });
      expect(cambioCodigo.status).toBe(400);
      // al cambiar de categoría sin indicar subcategoría, la anterior (de la otra categoría) se quita
      const r3 = await http()
        .put(`/api/operaciones/inventario/articulos/${a.id}`)
        .set(bodeguero())
        .send({ categoriaId: ids.categoriaOtra });
      expect(r3.status).toBe(200);
      expect(r3.body.subcategoria).toBeNull();
      expect(r3.body.categoria.id).toBe(ids.categoriaOtra);
    });

    it('busca por código, nombre y código alterno, y filtra químicos y con stock', async () => {
      const a = await crearArticulo('E');
      await http()
        .put(`/api/operaciones/inventario/articulos/${a.id}`)
        .set(bodeguero())
        .send({ codigos: { barras: `BAR${n}` } });
      const porCodigo = await http()
        .get(`/api/operaciones/inventario/articulos?q=it${n}e`)
        .set(lector());
      expect(porCodigo.body.map((x: { id: string }) => x.id)).toEqual([a.id]);
      const porBarras = await http()
        .get(`/api/operaciones/inventario/articulos?q=BAR${n}`)
        .set(lector());
      expect(porBarras.body.map((x: { id: string }) => x.id)).toEqual([a.id]);
      const quimicos = await http()
        .get(`/api/operaciones/inventario/articulos?quimicos=true&q=IT${n}E`)
        .set(lector());
      expect(quimicos.body).toHaveLength(1);
      const sinStock = await http()
        .get(`/api/operaciones/inventario/articulos?conStock=true&q=IT${n}E`)
        .set(lector());
      expect(sinStock.body).toHaveLength(0);
    });

    it('un lector no administra y quien no tiene permisos no entra', async () => {
      expect(
        (
          await http().post('/api/operaciones/inventario/articulos').set(lector()).send({
            codigo: 'X',
            nombre: 'x',
            categoriaId: ids.categoria,
            unidadStockId: ids.unidad,
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await http()
            .post('/api/operaciones/inventario/categorias')
            .set(lector())
            .send({ nombre: 'x' })
        ).status,
      ).toBe(403);
      expect(
        (await http().get('/api/operaciones/inventario/articulos').set(sinPermisos())).status,
      ).toBe(403);
      expect((await http().get('/api/operaciones/inventario/articulos')).status).toBe(401);
    });

    it('rechaza una categoría repetida con un mensaje claro', async () => {
      const r = await http()
        .post('/api/operaciones/inventario/categorias')
        .set(bodeguero())
        .send({ nombre: `CAT-IT ${n}` });
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('NOMBRE_DUPLICADO');
    });
  });

  describe('kardex', () => {
    it('calcula el saldo por bodega, rechaza lo que dejaría el stock negativo y el stock es la suma del kardex', async () => {
      const a = await crearArticulo('K1');
      const compra = await mover(a.id, BODEGA_A.id, ids.motivoCompra, 100, {
        observacion: 'Factura 001',
      });
      expect(compra.status).toBe(201);
      expect(compra.body).toMatchObject({
        tipo: 'entrada',
        origen: 'compra',
        cantidad: 100,
        saldoResultante: 100,
        bodega: { nombre: BODEGA_A.nombre },
        motivo: { nombre: 'Compra' },
        responsable: { id: BODEGUERO.id },
        observacion: 'Factura 001',
      });
      expect((await mover(a.id, BODEGA_A.id, ids.motivoFaltante, 30.5)).body.saldoResultante).toBe(
        69.5,
      );
      await mover(a.id, BODEGA_B.id, ids.motivoCompra, 10);

      // 80 de la bodega A no hay (69,5), aunque en total sí (79,5)
      const de_mas = await mover(a.id, BODEGA_A.id, ids.motivoFaltante, 80);
      expect(de_mas.status).toBe(409);
      expect(de_mas.body.code).toBe('STOCK_INSUFICIENTE');

      const stock = await stockDe(a.id);
      expect(stock.total).toBe(79.5);
      expect(
        stock.porBodega.map((b: { bodega: string; stock: number }) => [b.bodega, b.stock]).sort(),
      ).toEqual([
        [BODEGA_A.nombre, 69.5],
        [BODEGA_B.nombre, 10],
      ]);
      // el stock es exactamente la suma de entradas menos salidas
      const suma = await admin.query(
        `SELECT COALESCE(SUM(CASE tipo WHEN 'entrada' THEN cantidad ELSE -cantidad END), 0)::float AS total
           FROM inventario.movimiento WHERE articulo_id = $1`,
        [a.id],
      );
      expect(suma.rows[0].total).toBe(79.5);
      // y lo mismo por bodega: el saldo de cada una es la suma de sus propios movimientos
      const porBodega = await admin.query(
        `SELECT bodega_id, SUM(CASE tipo WHEN 'entrada' THEN cantidad ELSE -cantidad END)::float AS total
           FROM inventario.movimiento WHERE articulo_id = $1 GROUP BY bodega_id`,
        [a.id],
      );
      expect(porBodega.rows).toHaveLength(2);
      for (const fila of porBodega.rows as Array<{ bodega_id: string; total: number }>) {
        const esperado = stock.porBodega.find(
          (b: { bodegaId: string }) => b.bodegaId === fila.bodega_id,
        );
        expect(esperado.stock).toBe(fila.total);
      }
      const lista = await http()
        .get(`/api/operaciones/inventario/articulos?q=IT${n}K1`)
        .set(lector());
      expect(lista.body[0].stockActual).toBe(79.5);

      const kardex = await http()
        .get(`/api/operaciones/inventario/articulos/${a.id}/movimientos?bodegaId=${BODEGA_A.id}`)
        .set(lector());
      expect(kardex.body.map((m: { saldoResultante: number }) => m.saldoResultante)).toEqual([
        100, 69.5,
      ]);
    });

    it('solo admite los motivos manuales; el saldo inicial y los de ticket los registra el sistema', async () => {
      const a = await crearArticulo('K2');
      const r = await mover(a.id, BODEGA_A.id, ids.motivoSaldoInicial, 5);
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('MOTIVO_NO_MANUAL');
    });

    it('valida la cantidad, la fecha y la bodega', async () => {
      const a = await crearArticulo('K3');
      expect((await mover(a.id, BODEGA_A.id, ids.motivoCompra, 0)).status).toBe(400);
      expect((await mover(a.id, BODEGA_A.id, ids.motivoCompra, -3)).status).toBe(400);
      expect((await mover(a.id, BODEGA_A.id, ids.motivoCompra, 1.2345)).status).toBe(400);
      const futura = await mover(a.id, BODEGA_A.id, ids.motivoCompra, 1, {
        fecha: '2999-01-01T00:00:00Z',
      });
      expect(futura.body.code).toBe('FECHA_FUTURA');
      const sinBodega = await mover(a.id, uuidv7(), ids.motivoCompra, 1);
      expect(sinBodega.body.code).toBe('BODEGA_INVALIDA');
      expect((await mover(uuidv7(), BODEGA_A.id, ids.motivoCompra, 1)).status).toBe(404);
      expect((await stockDe(a.id)).total).toBe(0);
    });

    it('el kardex es inmutable: la aplicación no puede modificar ni borrar un renglón', async () => {
      const a = await crearArticulo('K4');
      const m = (await mover(a.id, BODEGA_A.id, ids.motivoCompra, 7)).body;
      const app_ = new Pool({ connectionString: APP_DB.replace('?pgbouncer=true', ''), max: 1 });
      try {
        await expect(
          app_.query('UPDATE inventario.movimiento SET cantidad = 1 WHERE id = $1', [m.id]),
        ).rejects.toThrow(/permission denied/);
        await expect(
          app_.query('DELETE FROM inventario.movimiento WHERE id = $1', [m.id]),
        ).rejects.toThrow(/permission denied/);
      } finally {
        await app_.end();
      }
      expect((await stockDe(a.id)).total).toBe(7);
    });

    it('la base rechaza lo inválido aunque la aplicación se equivoque (cantidad, saldo, motivo/tipo/origen, referencias)', async () => {
      const a = await crearArticulo('K5');
      const insertar = (o: {
        cantidad?: number;
        saldo?: number;
        tipo?: string;
        origen?: string;
        motivoId?: string;
        ticket?: string | null;
        despacho?: string | null;
      }) =>
        admin.query(
          `INSERT INTO inventario.movimiento (id, articulo_id, bodega_id, tipo, origen, motivo_id, cantidad, saldo_resultante, fecha, responsable_id, ticket_pumping_id, despacho_id)
           VALUES ($1, $2, $3, $4::inventario.tipo_movimiento, $5::inventario.origen_movimiento, $6, $7, $8, now(), $9, $10, $11)`,
          [
            uuidv7(),
            a.id,
            BODEGA_A.id,
            o.tipo ?? 'entrada',
            o.origen ?? 'compra',
            o.motivoId ?? ids.motivoCompra,
            o.cantidad ?? 1,
            o.saldo ?? 1,
            BODEGUERO.id,
            o.ticket ?? null,
            o.despacho ?? null,
          ],
        );
      const salidaTicket = {
        tipo: 'salida',
        origen: 'salida_ticket',
        motivoId: ids.motivoSalidaTicket,
        saldo: 0,
      };
      const salidaDespacho = {
        tipo: 'salida',
        origen: 'despacho_bodega',
        motivoId: ids.motivoDespacho,
        saldo: 0,
      };
      await expect(insertar({ cantidad: 0, saldo: 0 })).rejects.toThrow(
        /movimiento_cantidad_check/,
      );
      await expect(
        insertar({
          cantidad: 1,
          saldo: -1,
          tipo: 'salida',
          origen: 'ajuste',
          motivoId: ids.motivoFaltante,
        }),
      ).rejects.toThrow(/movimiento_saldo_check/);
      // el tipo y el origen del movimiento son los de su motivo (FK compuesta): una salida con el motivo «Compra» no pasa
      await expect(insertar({ tipo: 'salida' })).rejects.toThrow(
        /movimiento_motivo_tipo_origen_fkey/,
      );
      await expect(insertar({ origen: 'ajuste' })).rejects.toThrow(
        /movimiento_motivo_tipo_origen_fkey/,
      );
      // salida o devolución de ticket sin ticket, despacho sin despacho, y referencias donde no corresponden
      await expect(
        insertar({
          tipo: 'entrada',
          origen: 'devolucion_ticket',
          motivoId: ids.motivoDevolucionTicket,
        }),
      ).rejects.toThrow(/movimiento_referencia_check/);
      await expect(insertar(salidaTicket)).rejects.toThrow(/movimiento_referencia_check/);
      await expect(insertar(salidaDespacho)).rejects.toThrow(/movimiento_referencia_check/);
      await expect(insertar({ ticket: TICKET_A })).rejects.toThrow(/movimiento_referencia_check/);
      // un ticket o un despacho que no existen tampoco pasan (FK real)
      await expect(insertar({ ...salidaTicket, ticket: uuidv7() })).rejects.toThrow(
        /movimiento_ticket_pumping_id_fkey/,
      );
      await expect(insertar({ ...salidaDespacho, despacho: uuidv7() })).rejects.toThrow(
        /movimiento_despacho_id_fkey/,
      );
      // y el motivo no puede cambiar de tipo ni de origen mientras haya movimientos que lo usan
      await mover(a.id, BODEGA_A.id, ids.motivoCompra, 1);
      await expect(
        admin.query(
          "UPDATE inventario.motivo_movimiento SET tipo = 'salida', origen = 'ajuste' WHERE id = $1",
          [ids.motivoCompra],
        ),
      ).rejects.toThrow(/movimiento_motivo_tipo_origen_fkey/);
    });

    it('25 salidas simultáneas de una unidad sobre 20 en bodega: salen exactamente 20, el saldo no baja de cero y los saldos no se repiten', async () => {
      const a = await crearArticulo('K6');
      await mover(a.id, BODEGA_A.id, ids.motivoCompra, 20);
      const resultados = await Promise.all(
        Array.from({ length: 25 }, () => mover(a.id, BODEGA_A.id, ids.motivoFaltante, 1)),
      );
      expect(resultados.filter((r) => r.status === 201)).toHaveLength(20);
      const rechazadas = resultados.filter((r) => r.status !== 201);
      expect(rechazadas).toHaveLength(5);
      expect(
        rechazadas.every((r) => r.status === 409 && r.body.code === 'STOCK_INSUFICIENTE'),
      ).toBe(true);
      expect((await stockDe(a.id)).total).toBe(0);
      const saldos = await admin.query(
        'SELECT saldo_resultante::float AS s FROM inventario.movimiento WHERE articulo_id = $1 ORDER BY secuencia',
        [a.id],
      );
      expect(saldos.rows.map((r: { s: number }) => r.s)).toEqual([
        20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0,
      ]);
    });

    it('30 entradas simultáneas: el saldo final es la suma y cada renglón parte del anterior', async () => {
      const a = await crearArticulo('K7');
      const resultados = await Promise.all(
        Array.from({ length: 30 }, () => mover(a.id, BODEGA_B.id, ids.motivoSobrante, 2)),
      );
      expect(resultados.every((r) => r.status === 201)).toBe(true);
      expect((await stockDe(a.id)).total).toBe(60);
      const filas = await admin.query(
        'SELECT saldo_resultante::float AS s FROM inventario.movimiento WHERE articulo_id = $1 ORDER BY secuencia',
        [a.id],
      );
      expect(filas.rows.map((r: { s: number }) => r.s)).toEqual(
        Array.from({ length: 30 }, (_, i) => (i + 1) * 2),
      );
    });

    it('publica un evento por movimiento y ninguno cuando se rechaza', async () => {
      const a = await crearArticulo('K8');
      const m = (await mover(a.id, BODEGA_A.id, ids.motivoCompra, 3)).body;
      await mover(a.id, BODEGA_A.id, ids.motivoFaltante, 50); // rechazado
      const salida = await admin.query(
        "SELECT tipo, datos FROM msg_operaciones.outbox WHERE datos->'data'->>'articuloId' = $1",
        [a.id],
      );
      expect(salida.rows).toHaveLength(1);
      expect(salida.rows[0].tipo).toBe('operaciones.inventario.movimiento_registrado');
      expect(salida.rows[0].datos).toMatchObject({
        source: 'operaciones',
        subject: { type: 'inventario_articulo', id: a.id },
        actor: { userId: BODEGUERO.id, role: 'bodeguero' },
        data: {
          movimientoId: m.id,
          articuloCodigo: a.codigo,
          bodegaId: BODEGA_A.id,
          tipo: 'entrada',
          origen: 'compra',
          cantidad: 3,
          saldoResultante: 3,
        },
      });
    });
  });

  describe('partes de una herramienta', () => {
    it('asigna el orden el servidor (también con altas simultáneas), edita y quita', async () => {
      const a = await crearArticulo('P1');
      const url = `/api/operaciones/inventario/articulos/${a.id}/partes`;
      const primera = await http()
        .post(url)
        .set(bodeguero())
        .send({ item: '1', codigo: 'P-1', descripcion: 'Resorte' });
      expect(primera.status).toBe(201);
      expect(primera.body).toMatchObject({ orden: 1, cantidadEsperada: 1 });
      const lote = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          http()
            .post(url)
            .set(bodeguero())
            .send({
              item: `${i + 2}`,
              codigo: `P-${i + 2}`,
              descripcion: 'Parte',
              cantidadEsperada: 2,
            }),
        ),
      );
      expect(lote.every((r) => r.status === 201)).toBe(true);
      const lista = await http().get(url).set(lector());
      expect(lista.body.map((p: { orden: number }) => p.orden)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8, 9,
      ]);
      const editada = await http()
        .put(`/api/operaciones/inventario/partes/${primera.body.id}`)
        .set(bodeguero())
        .send({ item: '1*', codigo: 'P-1', descripcion: 'Resorte nuevo', cantidadEsperada: 3 });
      expect(editada.body).toMatchObject({
        item: '1*',
        descripcion: 'Resorte nuevo',
        cantidadEsperada: 3,
        orden: 1,
      });
      expect(
        (
          await http()
            .delete(`/api/operaciones/inventario/partes/${primera.body.id}`)
            .set(bodeguero())
        ).status,
      ).toBe(204);
      expect((await http().get(url).set(lector())).body).toHaveLength(8);
      expect(
        (
          await http()
            .delete(`/api/operaciones/inventario/partes/${primera.body.id}`)
            .set(bodeguero())
        ).status,
      ).toBe(404);
      expect(
        (await http().get(`/api/operaciones/inventario/articulos/${uuidv7()}/partes`).set(lector()))
          .status,
      ).toBe(404);
    });
  });

  describe('catálogos de apoyo', () => {
    it('lista unidades, motivos (con los manuales), bodegas y categorías con sus subcategorías', async () => {
      const motivos = await http()
        .get('/api/operaciones/inventario/motivos?manual=true')
        .set(lector());
      expect(motivos.status).toBe(200);
      const nombres = motivos.body.map((m: { nombre: string }) => m.nombre);
      expect(nombres).toContain('Compra');
      expect(nombres).not.toContain('Saldo inicial');
      const unidad = await http()
        .post('/api/operaciones/inventario/unidades')
        .set(bodeguero())
        .send({ nombre: `IT-Cubeta ${n}`, simbolo: 'cbt' });
      expect(unidad.status).toBe(201);
      const bodegas = await http().get('/api/operaciones/inventario/bodegas').set(lector());
      expect(bodegas.body.map((b: { id: string }) => b.id)).toEqual(
        expect.arrayContaining([BODEGA_A.id, BODEGA_B.id]),
      );
      const cats = await http().get('/api/operaciones/inventario/categorias').set(lector());
      const mia = cats.body.find((c: { id: string }) => c.id === ids.categoria);
      expect(mia.subcategorias.map((s: { id: string }) => s.id)).toEqual([ids.subcategoria]);
    });
  });

  describe('ticket de Pumping: salida, consumo y devolución', () => {
    const actor = { id: BODEGUERO.id, roleCode: 'bodeguero' as RoleCode };
    const enTx = <T>(
      f: (tx: Parameters<Parameters<PrismaService['$transaction']>[0]>[0]) => Promise<T>,
    ) => prisma.$transaction((tx) => f(tx));
    const evento = async (articuloId: string) =>
      (
        await admin.query(
          "SELECT tipo, datos FROM msg_operaciones.outbox WHERE datos->'data'->>'articuloId' = $1 ORDER BY id",
          [articuloId],
        )
      ).rows as Array<{ tipo: string; datos: { data: Record<string, unknown> } }>;

    it('la salida baja el stock y queda a cargo del ticket; la devolución y el consumo se calculan y no superan lo asignado', async () => {
      const a = await crearArticulo('T1');
      await mover(a.id, BODEGA_A.id, ids.motivoCompra, 10);
      const base = { ticketPumpingId: TICKET_A, articuloId: a.id, bodegaId: BODEGA_A.id };

      const salida = await enTx((tx) =>
        movimientosSvc.registrarSalida(tx, { ...base, cantidad: 6 }, actor),
      );
      expect(salida).toMatchObject({
        tipo: 'salida',
        origen: 'salida_ticket',
        ticketPumpingId: TICKET_A,
      });
      expect(await movimientosSvc.stockDe(a.id)).toBe(4);
      expect(await movimientosSvc.stockDe(a.id, BODEGA_A.id)).toBe(4);

      await enTx((tx) =>
        movimientosSvc.registrarConsumo(
          tx,
          { ticketPumpingId: TICKET_A, articuloId: a.id, cantidad: 3.5 },
          actor,
        ),
      );
      // el consumo no mueve stock
      expect(await movimientosSvc.stockDe(a.id)).toBe(4);
      // quedan 2,5 a cargo del ticket: no se puede consumir 3 ni devolver 3
      const demasiadoConsumo = enTx((tx) =>
        movimientosSvc.registrarConsumo(
          tx,
          { ticketPumpingId: TICKET_A, articuloId: a.id, cantidad: 3 },
          actor,
        ),
      );
      await expect(demasiadoConsumo).rejects.toMatchObject({
        response: { code: 'EXCEDE_LO_ASIGNADO' },
      });
      const demasiadaDevolucion = enTx((tx) =>
        movimientosSvc.registrarDevolucion(tx, { ...base, cantidad: 3 }, actor),
      );
      await expect(demasiadaDevolucion).rejects.toMatchObject({
        response: { code: 'EXCEDE_LO_ASIGNADO' },
      });

      const devolucion = await enTx((tx) =>
        movimientosSvc.registrarDevolucion(tx, { ...base, cantidad: 2.5 }, actor),
      );
      expect(devolucion).toMatchObject({
        tipo: 'entrada',
        origen: 'devolucion_ticket',
        saldoResultante: expect.anything(),
      });
      expect(await movimientosSvc.stockDe(a.id)).toBe(6.5);

      const [b] = await movimientosSvc.balanceDeTicket(TICKET_A, a.id);
      expect([b.asignada, b.usada, b.devuelta, b.pendiente].map(Number)).toEqual([6, 3.5, 2.5, 0]);
      // lo mismo por HTTP, para la pantalla del ticket
      const http1 = await http()
        .get(`/api/operaciones/inventario/tickets/${TICKET_A}/articulos`)
        .set(lector());
      expect(http1.body.find((x: { articuloId: string }) => x.articuloId === a.id)).toEqual({
        articuloId: a.id,
        asignada: 6,
        usada: 3.5,
        devuelta: 2.5,
        pendiente: 0,
      });
      // el consumo es historia: la aplicación no lo modifica ni lo borra
      const app_ = new Pool({ connectionString: APP_DB.replace('?pgbouncer=true', ''), max: 1 });
      try {
        await expect(
          app_.query('UPDATE inventario.consumo_ticket SET cantidad = 1 WHERE articulo_id = $1', [
            a.id,
          ]),
        ).rejects.toThrow(/permission denied/);
        await expect(
          app_.query('DELETE FROM inventario.consumo_ticket WHERE articulo_id = $1', [a.id]),
        ).rejects.toThrow(/permission denied/);
      } finally {
        await app_.end();
      }
    });

    it('cada hecho publica su evento: salida, consumo y devolución del ticket', async () => {
      const a = await crearArticulo('T2');
      await mover(a.id, BODEGA_A.id, ids.motivoCompra, 5);
      const base = { ticketPumpingId: TICKET_A, articuloId: a.id, bodegaId: BODEGA_A.id };
      await enTx((tx) => movimientosSvc.registrarSalida(tx, { ...base, cantidad: 4 }, actor));
      await enTx((tx) =>
        movimientosSvc.registrarConsumo(
          tx,
          { ticketPumpingId: TICKET_A, articuloId: a.id, cantidad: 1 },
          actor,
        ),
      );
      await enTx((tx) => movimientosSvc.registrarDevolucion(tx, { ...base, cantidad: 3 }, actor));
      const e = await evento(a.id);
      expect(e.map((x) => x.tipo)).toEqual([
        'operaciones.inventario.movimiento_registrado', // la compra manual
        'operaciones.inventario.salida_registrada',
        'operaciones.inventario.consumo_registrado',
        'operaciones.inventario.devolucion_registrada',
      ]);
      expect(e[1].datos.data).toMatchObject({
        ticketId: TICKET_A,
        articuloCodigo: a.codigo,
        cantidad: 4,
        saldoResultante: 1,
        origen: 'salida_ticket',
      });
      expect(e[2].datos.data).toMatchObject({ ticketId: TICKET_A, cantidad: 1 });
    });

    it('si la salida falla (stock insuficiente) no queda nada: ni movimiento ni evento; y con un ticket que no existe tampoco', async () => {
      const a = await crearArticulo('T3');
      await mover(a.id, BODEGA_A.id, ids.motivoCompra, 2);
      const base = { articuloId: a.id, bodegaId: BODEGA_A.id };
      await expect(
        enTx((tx) =>
          movimientosSvc.registrarSalida(
            tx,
            { ...base, ticketPumpingId: TICKET_B, cantidad: 5 },
            actor,
          ),
        ),
      ).rejects.toMatchObject({
        response: { code: 'STOCK_INSUFICIENTE' },
      });
      await expect(
        enTx((tx) =>
          movimientosSvc.registrarSalida(
            tx,
            { ...base, ticketPumpingId: uuidv7(), cantidad: 1 },
            actor,
          ),
        ),
      ).rejects.toMatchObject({
        response: { code: 'TICKET_INVALIDO' },
      });
      expect(await movimientosSvc.stockDe(a.id)).toBe(2);
      expect((await evento(a.id)).map((x) => x.tipo)).toEqual([
        'operaciones.inventario.movimiento_registrado',
      ]);
    });

    it('un movimiento manual no puede llevar ticket y las salidas de ticket no se registran a mano', async () => {
      const a = await crearArticulo('T4');
      const r = await mover(a.id, BODEGA_A.id, ids.motivoSalidaTicket, 1);
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('MOTIVO_NO_MANUAL');
    });

    it('10 salidas simultáneas del mismo ticket sobre 6 en bodega: salen 6, el saldo queda en cero', async () => {
      const a = await crearArticulo('T5');
      await mover(a.id, BODEGA_B.id, ids.motivoCompra, 6);
      const rs = await Promise.allSettled(
        Array.from({ length: 10 }, () =>
          enTx((tx) =>
            movimientosSvc.registrarSalida(
              tx,
              { ticketPumpingId: TICKET_B, articuloId: a.id, bodegaId: BODEGA_B.id, cantidad: 1 },
              actor,
            ),
          ),
        ),
      );
      expect(rs.filter((r) => r.status === 'fulfilled')).toHaveLength(6);
      expect(await movimientosSvc.stockDe(a.id)).toBe(0);
    });
  });

  describe('despachos a bodega (eventos de comercial)', () => {
    const evtDespacho = (
      type: string,
      data: Record<string, unknown>,
      extra: Partial<EventEnvelope> = {},
    ): EventEnvelope => {
      const id = uuidv7();
      eventosEnviados.push(id);
      return {
        id,
        type,
        version: 1,
        occurredAt: new Date().toISOString(),
        source: 'comercial',
        subject: { type: 'pedido', id: PEDIDO_DESPACHO },
        data: { pedidoId: PEDIDO_DESPACHO, ...data },
        actor: { userId: BODEGUERO.id, role: 'bodeguero' },
        ...extra,
      } as EventEnvelope;
    };
    const despacho = async () =>
      (
        await admin.query('SELECT * FROM inventario.despacho WHERE pedido_id = $1', [
          PEDIDO_DESPACHO,
        ])
      ).rows[0];

    it('registra la solicitud una sola vez aunque el evento llegue repetido', async () => {
      const e = evtDespacho('comercial.despacho.solicitado', {});
      await despachosConsumer.consumir(e);
      await despachosConsumer.consumir(e);
      const d = await despacho();
      expect(d).toMatchObject({
        estado: 'solicitado',
        solicitado_por: BODEGUERO.id,
        realizado_at: null,
        archivo_respaldo_id: null,
      });
      expect(
        (
          await admin.query(
            'SELECT count(*)::int AS c FROM inventario.despacho WHERE pedido_id = $1',
            [PEDIDO_DESPACHO],
          )
        ).rows[0].c,
      ).toBe(1);
    });

    it('ignora sin error un evento sin pedido, con una cuenta que no existe o con un archivo que no existe', async () => {
      await despachosConsumer.consumir(
        evtDespacho('comercial.despacho.solicitado', { pedidoId: null }),
      );
      await despachosConsumer.consumir(
        evtDespacho(
          'comercial.despacho.solicitado',
          {},
          { actor: { userId: uuidv7(), role: 'x' } },
        ),
      );
      await despachosConsumer.consumir(
        evtDespacho('comercial.despacho.resuelto', {
          archivoRespaldoId: uuidv7(),
          archivoMsdsId: null,
        }),
      );
      await despachosConsumer.consumir(
        evtDespacho('comercial.despacho.resuelto', { archivoRespaldoId: null }),
      );
      expect((await despacho()).estado).toBe('solicitado');
    });

    it('lista y muestra el despacho; las salidas de stock lo respaldan y se rechazan sin stock', async () => {
      const a = await crearArticulo('D1');
      await mover(a.id, BODEGA_A.id, ids.motivoCompra, 10);
      const d = await despacho();
      const lista = await http()
        .get('/api/operaciones/inventario/despachos?estado=solicitado')
        .set(bodeguero());
      expect(lista.body.find((x: { id: string }) => x.id === d.id)).toMatchObject({
        pedidoId: PEDIDO_DESPACHO,
        estado: 'solicitado',
        movimientos: 0,
      });
      const ok = await http()
        .post(`/api/operaciones/inventario/despachos/${d.id}/movimientos`)
        .set(bodeguero())
        .send({ articuloId: a.id, bodegaId: BODEGA_A.id, cantidad: 4, observacion: 'Guía 001' });
      expect(ok.status).toBe(201);
      expect(ok.body.movimientos).toHaveLength(1);
      expect(ok.body.movimientos[0]).toMatchObject({
        origen: 'despacho_bodega',
        tipo: 'salida',
        cantidad: 4,
        saldoResultante: 6,
        despachoId: d.id,
      });
      const sinStock = await http()
        .post(`/api/operaciones/inventario/despachos/${d.id}/movimientos`)
        .set(bodeguero())
        .send({ articuloId: a.id, bodegaId: BODEGA_A.id, cantidad: 50 });
      expect(sinStock.body.code).toBe('STOCK_INSUFICIENTE');
      // quien solo lee el catálogo no ve los despachos
      expect((await http().get('/api/operaciones/inventario/despachos').set(lector())).status).toBe(
        403,
      );
    });

    it('al resolverse queda el documento de respaldo y la hoja MSDS, y ya no admite más salidas', async () => {
      await despachosConsumer.consumir(
        evtDespacho('comercial.despacho.resuelto', {
          archivoRespaldoId: ARCHIVO_RESPALDO,
          archivoMsdsId: ARCHIVO_MSDS,
        }),
      );
      const d = await despacho();
      expect(d).toMatchObject({
        estado: 'realizado',
        realizado_por: BODEGUERO.id,
        archivo_respaldo_id: ARCHIVO_RESPALDO,
        archivo_msds_id: ARCHIVO_MSDS,
      });
      const a = await crearArticulo('D2');
      await mover(a.id, BODEGA_A.id, ids.motivoCompra, 3);
      const r = await http()
        .post(`/api/operaciones/inventario/despachos/${d.id}/movimientos`)
        .set(bodeguero())
        .send({ articuloId: a.id, bodegaId: BODEGA_A.id, cantidad: 1 });
      expect(r.body.code).toBe('DESPACHO_REALIZADO');
    });

    it('una nueva solicitud del mismo pedido reabre el despacho y limpia lo realizado', async () => {
      await despachosConsumer.consumir(evtDespacho('comercial.despacho.solicitado', {}));
      expect(await despacho()).toMatchObject({
        estado: 'solicitado',
        realizado_at: null,
        archivo_respaldo_id: null,
        archivo_msds_id: null,
      });
    });

    it('la base exige el respaldo cuando está realizado y lo prohíbe cuando está solicitado', async () => {
      await expect(
        admin.query("UPDATE inventario.despacho SET estado = 'realizado' WHERE pedido_id = $1", [
          PEDIDO_DESPACHO,
        ]),
      ).rejects.toThrow(/despacho_estado_check/);
      await expect(
        admin.query('UPDATE inventario.despacho SET archivo_msds_id = $2 WHERE pedido_id = $1', [
          PEDIDO_DESPACHO,
          ARCHIVO_MSDS,
        ]),
      ).rejects.toThrow(/despacho_estado_check/);
    });
  });

  describe('categorías: el comportamiento depende de las marcas, no del nombre', () => {
    it('el listado de químicos y las partes siguen a `es_quimica` y `lleva_partes`', async () => {
      const a = await crearArticulo('C1');
      // la categoría de prueba se llama «CAT-IT…», no «QUIMICA», y aun así es de químicos
      expect(
        (
          await http()
            .get(`/api/operaciones/inventario/articulos?quimicos=true&q=${a.codigo}`)
            .set(lector())
        ).body,
      ).toHaveLength(1);
      await http()
        .put(`/api/operaciones/inventario/categorias/${ids.categoria}`)
        .set(bodeguero())
        .send({ esQuimica: false, llevaPartes: true });
      expect(
        (
          await http()
            .get(`/api/operaciones/inventario/articulos?quimicos=true&q=${a.codigo}`)
            .set(lector())
        ).body,
      ).toHaveLength(0);
      expect(
        (await http().get(`/api/operaciones/inventario/articulos/${a.id}`).set(lector())).body
          .categoria,
      ).toMatchObject({ esQuimica: false, llevaPartes: true });
      await http()
        .put(`/api/operaciones/inventario/categorias/${ids.categoria}`)
        .set(bodeguero())
        .send({ esQuimica: true, llevaPartes: false });
    });

    it('los códigos del artículo guardan quién los creó y los cambió', async () => {
      const a = await crearArticulo('C2');
      await http()
        .put(`/api/operaciones/inventario/articulos/${a.id}`)
        .set(bodeguero())
        .send({ codigos: { barras: '123' } });
      const fila = await admin.query(
        'SELECT created_by, updated_by FROM inventario.articulo_codigo WHERE articulo_id = $1',
        [a.id],
      );
      expect(fila.rows[0]).toEqual({ created_by: BODEGUERO.id, updated_by: BODEGUERO.id });
    });
  });

  describe('EPP: artículos que se entregan a una persona (QHSE los recibe por evento)', () => {
    const url = '/api/operaciones/inventario/articulos';
    const eventosDe = async (articuloId: string) =>
      (
        await admin.query(
          "SELECT datos->'data' AS d FROM msg_operaciones.outbox WHERE tipo = 'operaciones.inventario.articulo_epi_actualizado' AND datos->'data'->>'articuloId' = $1 ORDER BY id",
          [articuloId],
        )
      ).rows.map((x) => x.d);
    const crearEpp = async (sufijo: string, extra: object = {}) => {
      const r = await http()
        .post(url)
        .set(bodeguero())
        .send({
          codigo: `EPP${n}${sufijo}`,
          nombre: `Botas de prueba ${sufijo}`,
          categoriaId: ids.categoria,
          unidadStockId: ids.unidad,
          entregaPersonal: true,
          tipoTalla: 'calzado',
          ...extra,
        });
      if (r.body?.id) articulos.push(r.body.id);
      return r;
    };

    it('crear un artículo de entrega personal con su tipo de talla publica el evento para QHSE; uno que no se entrega no lo publica', async () => {
      const r = await crearEpp('A');
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({
        entregaPersonal: true,
        tipoTalla: 'calzado',
        equivalencias: [],
      });
      expect(await eventosDe(r.body.id)).toEqual([
        {
          articuloId: r.body.id,
          codigo: `EPP${n}A`,
          nombre: 'Botas de prueba A',
          tipoTalla: 'calzado',
          entregaPersonal: true,
          activo: true,
        },
      ]);
      const comun = await crearArticulo('E1');
      expect(await eventosDe(comun.id)).toEqual([]);
    });

    it('la talla exige que el artículo se entregue a una persona: el servicio lo rechaza y la base también', async () => {
      const r = await crearEpp('B', { entregaPersonal: false });
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('TALLA_SIN_ENTREGA');
      const a = await crearArticulo('E2');
      await expect(
        admin.query("UPDATE inventario.articulo SET tipo_talla = 'ropa' WHERE id = $1", [a.id]),
      ).rejects.toThrow(/articulo_tipo_talla_check/);
    });

    it('dejar de entregarlo a una persona quita la talla y vuelve a publicar (QHSE lo desactiva); un cambio de nombre también se publica', async () => {
      const r = await crearEpp('C');
      await http()
        .put(`${url}/${r.body.id}`)
        .set(bodeguero())
        .send({ nombre: 'Botas renombradas' })
        .expect(200);
      const baja = await http()
        .put(`${url}/${r.body.id}`)
        .set(bodeguero())
        .send({ entregaPersonal: false })
        .expect(200);
      expect(baja.body).toMatchObject({ entregaPersonal: false, tipoTalla: null });
      const eventos = await eventosDe(r.body.id);
      expect(eventos.map((e) => [e.nombre, e.entregaPersonal, e.tipoTalla])).toEqual([
        ['Botas de prueba C', true, 'calzado'],
        ['Botas renombradas', true, 'calzado'],
        ['Botas renombradas', false, null],
      ]);
    });

    it('republicar manda todos los que se entregan a una persona; solo lo hace quien administra el catálogo', async () => {
      const a = await crearEpp('D');
      await http().post(`${url}/epi/republicar`).set(lector()).expect(403);
      const r = await http().post(`${url}/epi/republicar`).set(bodeguero()).expect(201);
      expect(r.body.publicados).toBeGreaterThanOrEqual(1);
      expect((await eventosDe(a.body.id)).length).toBe(2);
    });

    it('un código de AS2 fusionado equivale a un solo artículo y se ve en su ficha', async () => {
      const a = await crearEpp('F');
      const b = await crearEpp('G');
      const codigo = `EQ${n}`;
      await admin.query(
        "INSERT INTO inventario.articulo_equivalencia (id, articulo_id, codigo, motivo) VALUES ($1, $2, $3, 'talla')",
        [uuidv7(), a.body.id, codigo],
      );
      await expect(
        admin.query(
          "INSERT INTO inventario.articulo_equivalencia (id, articulo_id, codigo, motivo) VALUES ($1, $2, $3, 'duplicado')",
          [uuidv7(), b.body.id, codigo],
        ),
      ).rejects.toThrow(/articulo_equivalencia_codigo_key/);
      const ficha = await http().get(`${url}/${a.body.id}`).set(lector()).expect(200);
      expect(ficha.body.equivalencias).toEqual([{ codigo, motivo: 'talla' }]);
    });
  });

  describe('carga del EPP de AS2', () => {
    it('es idempotente y deja los 58 artículos depurados (37 de entrega personal) con las 11 equivalencias de AS2', async () => {
      await cargarEpp(prisma); // si aún no estaba cargado, la primera vez lo carga
      const r = await cargarEpp(prisma);
      expect(r).toMatchObject({ articulos: 0, yaExistian: 58, equivalencias: 0 });
      const c = await admin.query(
        `SELECT count(*)::int AS articulos,
                count(*) FILTER (WHERE entrega_personal)::int AS personales,
                (SELECT count(*)::int FROM inventario.articulo_equivalencia q JOIN inventario.articulo x ON x.id = q.articulo_id WHERE x.codigo LIKE 'EPP-%') AS equivalencias
           FROM inventario.articulo WHERE codigo LIKE 'EPP-%'`,
      );
      expect(c.rows[0]).toEqual({ articulos: 58, personales: 37, equivalencias: 11 });
      // las tallas no son artículos: las botas, el overol y los guantes llevan su tipo de talla y las tallas fusionadas son equivalencias
      const botas = await admin.query(
        `SELECT a.tipo_talla, array_agg(e.codigo ORDER BY e.codigo) AS equivalentes
           FROM inventario.articulo a JOIN inventario.articulo_equivalencia e ON e.articulo_id = a.id
          WHERE a.codigo = 'EPP-0038' GROUP BY a.tipo_talla`,
      );
      expect(botas.rows[0]).toEqual({
        tipo_talla: 'calzado',
        equivalentes: ['EPP-0039', 'EPP-0040', 'EPP-0041', 'EPP-0042'],
      });
      // el dato personal (overoles bordados con nombre de persona) no se cargó
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM inventario.articulo WHERE nombre ILIKE '%BORDADO%'",
          )
        ).rows[0].n,
      ).toBe(0);
    });
  });

  describe('bienes de AS2: químicos, completion, fishing y repuestos de mantenimiento', () => {
    const url = '/api/operaciones/inventario/articulos';

    it('la carga es idempotente y deja 1.268 artículos nuevos con los códigos sin espacios', async () => {
      await cargarBienesAs2(prisma); // si aún no estaba cargada, la primera vez la carga
      const r = await cargarBienesAs2(prisma);
      expect(r).toMatchObject({ articulos: 0, yaExistian: 1268, equivalencias: 0 });
      const c = await admin.query(
        `SELECT c.nombre AS categoria, count(*)::int AS n
           FROM inventario.articulo a JOIN inventario.categoria_articulo c ON c.id = a.categoria_id
          WHERE a.codigo = ANY($1::text[]) GROUP BY 1 ORDER BY 1`,
        [cargasPosteriores().filter((x) => !x.startsWith('EPP-'))],
      );
      expect(Object.fromEntries(c.rows.map((x) => [x.categoria, x.n]))).toEqual({
        'COMPLETION BIENES': 98,
        'FISHING & TOOLS': 46,
        'FISHING CONSUMO': 129,
        MANTENIMIENTO: 653,
        QUIMICA: 342,
      });
      // los códigos con espacios se normalizan (también los de la carga inicial) y el original de AS2 queda como equivalencia «formato»
      await normalizarCodigos(prisma);
      expect((await normalizarCodigos(prisma)).normalizados).toBe(0); // idempotente
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM inventario.articulo WHERE codigo ~ '[[:space:]]' AND codigo NOT LIKE 'IT%'",
          )
        ).rows[0].n,
      ).toBe(0);
      const eq = await admin.query(
        `SELECT a.codigo, e.codigo AS original FROM inventario.articulo_equivalencia e JOIN inventario.articulo a ON a.id = e.articulo_id
          WHERE e.motivo = 'formato' AND e.codigo IN ('DYFE - 100', 'DYS - 302', 'DYFE - 200') ORDER BY e.codigo`,
      );
      expect(eq.rows).toEqual([
        { codigo: 'DYFE-100-2', original: 'DYFE - 100' },
        { codigo: 'DYFE-200-2', original: 'DYFE - 200' },
        { codigo: 'DYS-302-2', original: 'DYS - 302' },
      ]);
    });

    it('un producto de AS2 sin nombre se carga con su código como nombre y una nota que lo dice', async () => {
      const r = await admin.query(
        "SELECT codigo, nombre, nota FROM inventario.articulo WHERE nota LIKE 'AS2 no trae nombre%' ORDER BY codigo LIMIT 1",
      );
      expect(r.rows[0].nombre).toBe(r.rows[0].codigo);
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM inventario.articulo WHERE nota LIKE 'AS2 no trae nombre%'",
          )
        ).rows[0].n,
      ).toBe(51);
    });

    it('los repuestos de mantenimiento se ofrecen por la marca de la categoría, no por su nombre', async () => {
      const todos = await http().get(url).query({ repuestos: 'true' }).set(lector()).expect(200);
      expect(todos.body.length).toBeGreaterThanOrEqual(653);
      expect(
        todos.body.every((a: { categoria: { esRepuesto: boolean } }) => a.categoria.esRepuesto),
      ).toBe(true);
      const cats = (
        await http().get('/api/operaciones/inventario/categorias').set(lector()).expect(200)
      ).body as Array<{
        nombre: string;
        esRepuesto: boolean;
      }>;
      expect(cats.filter((c) => c.esRepuesto).map((c) => c.nombre)).toEqual(['MANTENIMIENTO']);
      // buscar un repuesto por su texto
      const uno = todos.body[0] as { nombre: string };
      const busqueda = await http()
        .get(url)
        .query({ repuestos: 'true', q: uno.nombre.slice(0, 12) })
        .set(lector())
        .expect(200);
      expect(busqueda.body.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('stock real por bodega y costos de AS2', () => {
    const leerJson = <T>(archivo: string): T =>
      JSON.parse(readFileSync(join(__dirname, '..', 'prisma', 'data', archivo), 'utf8')) as T;

    it('deja el saldo de cada artículo y bodega igual al reporte de stock de AS2 y es idempotente', async () => {
      await cargarStockAs2(prisma); // si aún no estaba cargado, la primera vez lo carga
      const r = await cargarStockAs2(prisma);
      expect(r).toMatchObject({
        saldosIniciales: 0,
        sobrantes: 0,
        faltantes: 0,
        aCero: 0,
        unidadesCorregidas: 0,
        costos: 0,
      });
      const reporte = leerJson<{ stock: Array<{ bodega: string; codigo: string; saldo: number }> }>(
        'stock-as2.json',
      ).stock;
      expect(r.sinCambio).toBe(reporte.length);
      const filas = await admin.query(
        `SELECT b.nombre AS bodega, a.codigo, s.saldo::float AS saldo
           FROM (SELECT DISTINCT ON (articulo_id, bodega_id) articulo_id, bodega_id, saldo_resultante AS saldo
                   FROM inventario.movimiento ORDER BY articulo_id, bodega_id, secuencia DESC) s
           JOIN inventario.articulo a ON a.id = s.articulo_id JOIN catalogos.bodega b ON b.id = s.bodega_id`,
      );
      // el archivo guarda los códigos en mayúsculas (AS2 los compara sin distinguir)
      const portal = new Map(
        filas.rows.map((x) => [`${x.bodega}|${x.codigo.toUpperCase()}`, Number(x.saldo)]),
      );
      const distintos = reporte.filter(
        (x) => Math.abs((portal.get(`${x.bodega}|${x.codigo}`) ?? 0) - x.saldo) > 0.0005,
      );
      expect(distintos).toEqual([]);
      // el reporte manda también sobre lo que no lista: ningún artículo con saldo en las bodegas del reporte fuera de él
      const bodegasReporte = new Set(reporte.map((x) => x.bodega));
      const clavesReporte = new Set(reporte.map((x) => `${x.bodega}|${x.codigo.toUpperCase()}`));
      const sobrantes = filas.rows.filter(
        (x) =>
          bodegasReporte.has(x.bodega) &&
          Number(x.saldo) > 0 &&
          !clavesReporte.has(`${x.bodega}|${x.codigo.toUpperCase()}`) &&
          !x.codigo.startsWith('IT'),
      );
      expect(sobrantes).toEqual([]);
    });

    it('cada artículo con saldo queda con la unidad real de AS2 y los ajustes quedan como movimientos con su motivo (el kardex no se edita)', async () => {
      const u = await admin.query(
        `SELECT u.nombre FROM inventario.articulo a JOIN inventario.unidad_stock u ON u.id = a.unidad_stock_id WHERE a.codigo = 'DYACET-100'`,
      );
      expect(u.rows[0].nombre).toBe('Galón');
      const m = await admin.query(
        `SELECT m2.nombre AS motivo, count(*)::int AS n FROM inventario.movimiento m
           JOIN inventario.motivo_movimiento m2 ON m2.id = m.motivo_id
          WHERE m.observacion LIKE 'Saldo según el reporte de stock de AS2%' GROUP BY 1`,
      );
      const por = Object.fromEntries(m.rows.map((x) => [x.motivo, x.n]));
      expect(por['Saldo inicial']).toBeGreaterThan(900);
      expect(por['Ajuste por conteo físico (faltante)']).toBeGreaterThan(0);
    });

    it('el costo unitario es el último costo de ingreso y no pisa un costo ya cargado', async () => {
      const costos = leerJson<{ costos: Array<{ codigo: string; costoUnitario: number }> }>(
        'costos-as2.json',
      ).costos;
      const c = costos.find((x) => x.codigo === '0256822');
      expect(c?.costoUnitario).toBe(2600);
      // el artículo ya tenía costo de la carga inicial: se conserva
      const a = await admin.query(
        "SELECT costo_unitario::float AS costo FROM inventario.articulo WHERE codigo = '0256822'",
      );
      expect(a.rows[0].costo).not.toBeNull();
      const sinCosto = await admin.query(
        'SELECT count(*)::int AS n FROM inventario.articulo WHERE costo_unitario IS NULL AND codigo = ANY($1::text[])',
        [costos.map((x) => x.codigo)],
      );
      expect(sinCosto.rows[0].n).toBe(0);
    });
  });

  describe('carga inicial desde AS2', () => {
    it('es idempotente: volver a cargarla no duplica artículos ni saldos', async () => {
      await cargarDatosReales(prisma); // si aún no estaba cargada, la primera vez la carga
      const antes = await admin.query(
        `SELECT (SELECT count(*) FROM inventario.articulo WHERE codigo NOT LIKE 'IT%' AND NOT (codigo = ANY($1::text[])) AND codigo NOT LIKE 'EPP%')::int AS articulos,
                (SELECT count(*) FROM inventario.movimiento WHERE origen = 'saldo_inicial')::int AS saldos`,
        [cargasPosteriores()],
      );
      const r = await cargarDatosReales(prisma);
      expect(r).toMatchObject({
        categorias: 0,
        subcategorias: 0,
        articulos: 0,
        saldosIniciales: 0,
        descuentos: 0,
        herramientas: 0,
        partes: 0,
      });
      const despues = await admin.query(
        `SELECT (SELECT count(*) FROM inventario.articulo WHERE codigo NOT LIKE 'IT%' AND NOT (codigo = ANY($1::text[])) AND codigo NOT LIKE 'EPP%')::int AS articulos,
                (SELECT count(*) FROM inventario.movimiento WHERE origen = 'saldo_inicial')::int AS saldos`,
        [cargasPosteriores()],
      );
      expect(despues.rows[0]).toEqual(antes.rows[0]);
      // 641 artículos del export de AS2 y 48 herramientas del registro de inspección, con sus 914 partes
      expect(despues.rows[0].articulos).toBe(689);
      const partes = await admin.query(
        "SELECT count(*)::int AS c FROM inventario.articulo_parte p JOIN inventario.articulo a ON a.id = p.articulo_id WHERE a.codigo NOT LIKE 'IT%'",
      );
      expect(partes.rows[0].c).toBe(914);
      // el stock cargado de un artículo conocido sale del kardex
      const e = await admin.query(
        "SELECT a.id FROM inventario.articulo a WHERE a.codigo = '63673'",
      );
      expect((await stockDe(e.rows[0].id)).total).toBe(8);
    });
  });
});
