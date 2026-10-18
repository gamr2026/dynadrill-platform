/**
 * Integración real de Mantenimiento (M1): Postgres (PgBouncer, app_operaciones). El receptor del reporte de unidad de llegada se
 * prueba llamando a `consumir` con un evento como el que publicará Pumping (sin RabbitMQ). Crea sus propios maestros reales
 * (usuarios, vehículo, unidad de Flota, ticket y reporte de Pumping) y limpia lo que crea; restaura el contador de reportes.
 *   RUN_INTEGRATION=1 npx nx test mantenimiento
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
import { DespachosConsumer, MovimientosService } from '@dyn/inventario';
import { ReporteUnidadLlegadaConsumer } from './consumers/reporte-unidad-llegada.consumer';
import { MantenimientoModule } from './mantenimiento.module';
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

const JEFE = { id: uuidv7(), nombre: 'Jorge Jefe de Mantenimiento' };
const MECANICO = { id: uuidv7(), nombre: 'Mario Mecánico' };
const INSTRUMENTISTA = { id: uuidv7(), nombre: 'Ivan Instrumentista' };
const MECANICO_INACTIVO = { id: uuidv7(), nombre: 'Inés Inactiva' };
const OPERADOR = { id: uuidv7(), nombre: 'Oscar Operador' };
const SUPERVISOR = { id: uuidv7(), nombre: 'Sara Supervisora' };
const VEHICULO = { id: uuidv7(), placa: `MT${String(n).slice(-5)}A` };
const VEHICULO_SIN_UNIDAD = { id: uuidv7(), placa: `MT${String(n).slice(-5)}B` };
const UNIDAD = { id: uuidv7(), codigo: `IT-${n}` };
const BODEGA = { id: uuidv7(), nombre: `BODEGA-MT ${n}` };
const CATEGORIA = uuidv7();
const ARTICULO = { id: uuidv7(), codigo: `REP-MT-${n}` };

const MAESTROS: MaestrosDePrueba = {
  usuarios: [
    { id: JEFE.id, nombre: JEFE.nombre, rol: 'jefe_mantenimiento' },
    { id: MECANICO.id, nombre: MECANICO.nombre, rol: 'operador_mantenimiento' },
    { id: INSTRUMENTISTA.id, nombre: INSTRUMENTISTA.nombre, rol: 'operador_mantenimiento' },
    {
      id: MECANICO_INACTIVO.id,
      nombre: MECANICO_INACTIVO.nombre,
      rol: 'operador_mantenimiento',
      activo: false,
    },
    { id: OPERADOR.id, nombre: OPERADOR.nombre, rol: 'operador' },
    { id: SUPERVISOR.id, nombre: SUPERVISOR.nombre, rol: 'supervisor' },
  ],
  vehiculos: [VEHICULO, VEHICULO_SIN_UNIDAD],
  bodegas: [BODEGA],
};

run('Mantenimiento: reportes recibidos y clasificación (base de datos real)', () => {
  jest.setTimeout(90000);
  let app: INestApplication;
  let prisma: PrismaService;
  let consumer: ReporteUnidadLlegadaConsumer;
  const admin = new Pool({ connectionString: MIGRATOR_DB, max: 2 });
  const http = () => request(app.getHttpServer());
  const signer = new JwtService({
    privateKey,
    signOptions: { algorithm: 'RS256', issuer: 'dynadrill-plataforma', expiresIn: 600 },
  });
  const token = (roleCode: string, name: string, permissions: string[], sub = uuidv7()) => ({
    Authorization: `Bearer ${signer.sign({ sub, email: `${roleCode}@test.local`, name, roleId: 'r', roleCode, permissions })}`,
  });
  const jefe = () =>
    token(
      'jefe_mantenimiento',
      JEFE.nombre,
      [P.MANTENIMIENTO_GESTIONAR, P.MANTENIMIENTO_VER, P.MANTENIMIENTO_OPERACIONES_VER],
      JEFE.id,
    );
  const soloLectura = () =>
    token('supervisor', SUPERVISOR.nombre, [P.MANTENIMIENTO_OPERACIONES_VER], SUPERVISOR.id);
  const mecanico = (id = MECANICO.id) =>
    token(
      'operador_mantenimiento',
      MECANICO.nombre,
      [P.MANTENIMIENTO_TAREAS, P.MANTENIMIENTO_VER],
      id,
    );
  const sinPermiso = () => token('operador', OPERADOR.nombre, [], OPERADOR.id);

  const tickets: string[] = [];
  const eventos: string[] = [];
  let contadorInicial = 0;

  /** Un ticket de Pumping con su reporte de unidad de llegada (como lo deja Pumping), listo para recibirse. */
  const reportePumping = async (
    opciones: {
      mecanica?: string | null;
      instrumentacion?: string | null;
      operaciones?: string | null;
      firmado?: boolean;
      vehiculoId?: string;
    } = {},
  ) => {
    const ticketId = uuidv7();
    const reporteId = uuidv7();
    const vehiculoId = opciones.vehiculoId ?? VEHICULO.id;
    tickets.push(ticketId);
    await admin.query(
      `INSERT INTO pumping.ticket (id, pedido_id, pedido_codigo, paso_codigo, ticket_numero)
       VALUES ($1, $2, $3, 'revision_inicial', $4)`,
      [ticketId, uuidv7(), `PED-MT${n}`, 700_000 + tickets.length + (n % 10_000) * 10],
    );
    await admin.query(
      'INSERT INTO pumping.ticket_unidad (ticket_id, vehiculo_id) VALUES ($1, $2)',
      [ticketId, vehiculoId],
    );
    const firmado = opciones.firmado ?? true;
    await admin.query(
      `INSERT INTO pumping.reporte_unidad
         (id, ticket_id, vehiculo_id, origen, destino, llegada_fecha, novedades_mecanica, novedades_instrumentacion,
          novedades_operaciones, unidad_lista, operacion_interrumpida, llegada_firmada_por, llegada_firmada_at)
       VALUES ($1, $2, $3, 'Base', 'Pozo X', '2026-11-06', $4, $5, $6, false, false, $7, $8)`,
      [
        reporteId,
        ticketId,
        vehiculoId,
        'mecanica' in opciones ? opciones.mecanica : 'Fuga de aceite en el motor',
        opciones.instrumentacion ?? null,
        opciones.operaciones ?? null,
        firmado ? OPERADOR.id : null,
        firmado ? new Date().toISOString() : null,
      ],
    );
    return { ticketId, reporteId };
  };

  const evento = (reporteUnidadId: string, extra: Record<string, unknown> = {}): EventEnvelope => {
    const id = uuidv7();
    eventos.push(id);
    return {
      id,
      type: 'operaciones.pumping.reporte_unidad_llegada',
      version: 1,
      occurredAt: '2026-11-06T10:00:00.000Z',
      source: 'operaciones',
      subject: { type: 'pumping_reporte_unidad', id: reporteUnidadId },
      actor: { userId: OPERADOR.id, role: 'operador' },
      data: { reporteUnidadId, hayNovedades: true, ...extra },
    };
  };

  /** Recibe un reporte de Pumping con novedades y devuelve el reporte de Mantenimiento ya creado. */
  const recibido = async () => {
    const { reporteId, ticketId } = await reportePumping();
    await consumer.consumir(evento(reporteId, { ticketId, vehiculoId: VEHICULO.id }));
    return prisma.reporteRecibido.findUniqueOrThrow({
      where: { pumpingReporteUnidadId: reporteId },
    });
  };

  beforeAll(async () => {
    await sembrarMaestros(admin, MAESTROS);
    await admin.query(
      `INSERT INTO flota.unidad (id, codigo, nombre, tipo, vehiculo_id, predeterminada, activa)
       VALUES ($1, $2, 'Unidad de prueba', 'transporte', $3, false, true)`,
      [UNIDAD.id, UNIDAD.codigo, VEHICULO.id],
    );
    await admin.query(
      'INSERT INTO inventario.categoria_articulo (id, nombre, es_repuesto) VALUES ($1, $2, true)',
      [CATEGORIA, `CAT-MT ${n}`],
    );
    await admin.query(
      `INSERT INTO inventario.articulo (id, codigo, nombre, categoria_id, unidad_stock_id)
       VALUES ($1, $2, 'Filtro de aceite de prueba', $3, (SELECT id FROM inventario.unidad_stock ORDER BY nombre LIMIT 1))`,
      [ARTICULO.id, ARTICULO.codigo, CATEGORIA],
    );
    contadorInicial = (
      await admin.query("SELECT valor FROM mantenimiento.contador WHERE clave = 'reporte'")
    ).rows[0].valor;
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
        MantenimientoModule,
      ],
    })
    class TestAppModule {}
    const mod = await Test.createTestingModule({ imports: [TestAppModule] }).compile();
    app = mod.createNestApplication();
    configureApp(app, { corsOrigins: ['http://localhost:4200'] });
    // sin RabbitMQ: el receptor se invoca a mano; evitamos que intente suscribirse al arrancar
    jest
      .spyOn(ReporteUnidadLlegadaConsumer.prototype, 'onApplicationBootstrap')
      .mockResolvedValue(undefined);
    jest.spyOn(DespachosConsumer.prototype, 'onApplicationBootstrap').mockResolvedValue(undefined);
    await app.init();
    prisma = app.get(PrismaService);
    consumer = app.get(ReporteUnidadLlegadaConsumer);
    // 20 unidades del repuesto en la bodega de prueba (compra, por la API de Inventario)
    const compra = (
      await admin.query("SELECT id FROM inventario.motivo_movimiento WHERE origen = 'compra'")
    ).rows[0].id;
    const entrada = await http()
      .post('/api/operaciones/inventario/movimientos')
      .set(token('bodeguero', 'Bruno Bodeguero', [P.ARTICULOS_GESTIONAR, P.ARTICULOS_VER], JEFE.id))
      .send({ articuloId: ARTICULO.id, bodegaId: BODEGA.id, motivoId: compra, cantidad: 20 });
    expect(entrada.status).toBe(201);
  });

  afterAll(async () => {
    // los renglones con salida registrada están protegidos (trigger): se desactiva solo para limpiar la prueba
    await admin.query(
      'ALTER TABLE mantenimiento.suborden_repuesto DISABLE TRIGGER suborden_repuesto_con_salida',
    );
    await admin.query(
      'DELETE FROM mantenimiento.orden WHERE reporte_id IN (SELECT id FROM mantenimiento.reporte_recibido WHERE unidad_id = $1)',
      [UNIDAD.id],
    );
    await admin.query('DELETE FROM mantenimiento.reporte_recibido WHERE unidad_id = $1', [
      UNIDAD.id,
    ]);
    await admin.query(
      'ALTER TABLE mantenimiento.suborden_repuesto ENABLE TRIGGER suborden_repuesto_con_salida',
    );
    await admin.query(
      'DELETE FROM inventario.salida_mantenimiento WHERE movimiento_id IN (SELECT id FROM inventario.movimiento WHERE articulo_id = $1)',
      [ARTICULO.id],
    );
    await admin.query('DELETE FROM inventario.movimiento WHERE articulo_id = $1', [ARTICULO.id]);
    await admin.query('DELETE FROM inventario.articulo WHERE id = $1', [ARTICULO.id]);
    await admin.query('DELETE FROM inventario.categoria_articulo WHERE id = $1', [CATEGORIA]);
    await admin.query(
      "DELETE FROM msg_operaciones.outbox WHERE datos->'data'->>'articuloId' = $1",
      [ARTICULO.id],
    );
    await admin.query('DELETE FROM pumping.ticket WHERE id = ANY($1::uuid[])', [tickets]);
    await admin.query('DELETE FROM flota.unidad WHERE id = $1', [UNIDAD.id]);
    if (eventos.length) {
      await admin.query('DELETE FROM msg_operaciones.inbox WHERE id = ANY($1::uuid[])', [eventos]);
    }
    await admin.query(
      "DELETE FROM msg_operaciones.outbox WHERE tipo LIKE 'operaciones.mantenimiento.%' AND datos->'data'->>'unidadId' = $1",
      [UNIDAD.id],
    );
    await admin.query("UPDATE mantenimiento.contador SET valor = $1 WHERE clave = 'reporte'", [
      contadorInicial,
    ]);
    await quitarMaestros(admin, MAESTROS);
    await admin.end();
    await app.close();
  });

  describe('recepción del reporte de unidad de llegada de Pumping', () => {
    it('recibe el reporte con novedades: queda por clasificar, con la unidad de Flota y su código', async () => {
      const r = await recibido();
      expect(r).toMatchObject({
        origen: 'pumping',
        unidadId: UNIDAD.id,
        recibidoPor: OPERADOR.id,
        descartadoAt: null,
      });
      expect(r.codigo).toMatch(/^R\d{4,}$/);

      const res = await http().get(`/api/operaciones/mantenimiento/reportes/${r.id}`).set(jefe());
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        codigo: r.codigo,
        estado: 'por_clasificar',
        unidad: { id: UNIDAD.id, codigo: UNIDAD.codigo, tipo: 'transporte' },
        novedades: {
          mecanica: 'Fuga de aceite en el motor',
          destino: 'Pozo X',
          unidadLista: false,
        },
        descarte: null,
        ordenId: null,
      });
      expect(res.body.ticket.numero).toEqual(expect.any(Number));
    });

    it('es idempotente: el mismo evento dos veces, o dos eventos del mismo reporte, dejan uno solo', async () => {
      const { reporteId } = await reportePumping();
      const e = evento(reporteId);
      await consumer.consumir(e);
      await consumer.consumir(e); // mismo evento: lo ignora el inbox
      await consumer.consumir(evento(reporteId)); // otro evento del mismo reporte
      expect(
        await prisma.reporteRecibido.count({ where: { pumpingReporteUnidadId: reporteId } }),
      ).toBe(1);
    });

    it('no recibe un reporte sin novedades (ni aunque el evento lo diga), ni uno con la llegada sin firmar', async () => {
      const sin = await reportePumping({ mecanica: '   ' });
      await consumer.consumir(evento(sin.reporteId, { hayNovedades: true }));
      const sinFirma = await reportePumping({ firmado: false });
      await consumer.consumir(evento(sinFirma.reporteId));
      const dice = await reportePumping();
      await consumer.consumir(evento(dice.reporteId, { hayNovedades: false }));
      for (const id of [sin.reporteId, sinFirma.reporteId, dice.reporteId]) {
        expect(await prisma.reporteRecibido.count({ where: { pumpingReporteUnidadId: id } })).toBe(
          0,
        );
      }
    });

    it('un reporte que cuenta una novedad solo en instrumentación u operaciones también entra', async () => {
      const r = await reportePumping({ mecanica: null, instrumentacion: 'DAS sin señal' });
      await consumer.consumir(evento(r.reporteId));
      expect(
        await prisma.reporteRecibido.count({ where: { pumpingReporteUnidadId: r.reporteId } }),
      ).toBe(1);
    });

    it('ignora sin error el evento al que le falta el reporte, uno de otro tipo y un vehículo sin unidad en Flota', async () => {
      await expect(consumer.consumir(evento('', {}))).resolves.toBeUndefined();
      await expect(
        consumer.consumir({ ...evento(uuidv7()), type: 'operaciones.pumping.salida_reportada' }),
      ).resolves.toBeUndefined();
      const huerfano = await reportePumping({ vehiculoId: VEHICULO_SIN_UNIDAD.id });
      await expect(consumer.consumir(evento(huerfano.reporteId))).resolves.toBeUndefined();
      expect(
        await prisma.reporteRecibido.count({
          where: { pumpingReporteUnidadId: huerfano.reporteId },
        }),
      ).toBe(0);
    });

    it('publica el aviso de reporte recibido con ids (sin nombres)', async () => {
      const r = await recibido();
      const salida = await admin.query(
        "SELECT datos->'data' AS d FROM msg_operaciones.outbox WHERE tipo = 'operaciones.mantenimiento.reporte.recibido' AND datos->'data'->>'reporteId' = $1",
        [r.id],
      );
      expect(salida.rows).toHaveLength(1);
      expect(salida.rows[0].d).toMatchObject({
        reporteId: r.id,
        codigo: r.codigo,
        unidadId: UNIDAD.id,
      });
      expect(Object.keys(salida.rows[0].d).sort()).toEqual(
        ['codigo', 'origen', 'reporteId', 'ticketId', 'unidadId'].sort(),
      );
    });
  });

  describe('bandeja y permisos', () => {
    it('lista por estado; la lectura de Operaciones alcanza para ver, no para clasificar', async () => {
      const r = await recibido();
      const lista = await http()
        .get('/api/operaciones/mantenimiento/reportes?estado=por_clasificar')
        .set(soloLectura());
      expect(lista.status).toBe(200);
      expect(lista.body.map((x: { id: string }) => x.id)).toContain(r.id);
      const descartados = await http()
        .get(`/api/operaciones/mantenimiento/reportes?estado=descartado&unidadId=${UNIDAD.id}`)
        .set(jefe());
      expect(descartados.body.map((x: { id: string }) => x.id)).not.toContain(r.id);

      const intento = await http()
        .post(`/api/operaciones/mantenimiento/reportes/${r.id}/descartar`)
        .set(soloLectura())
        .send({ motivo: 'x' });
      expect(intento.status).toBe(403);
      expect(
        (await http().get('/api/operaciones/mantenimiento/reportes').set(sinPermiso())).status,
      ).toBe(403);
      expect((await http().get('/api/operaciones/mantenimiento/reportes')).status).toBe(401);
    });

    it('el catálogo de tipos trae los tres de la demo; el operativo no es asignable', async () => {
      const res = await http().get('/api/operaciones/mantenimiento/tipos-suborden').set(jefe());
      expect(res.body).toEqual([
        { codigo: 'mecanico', nombre: 'Mecánico', sufijo: 'M', asignable: true },
        { codigo: 'instrumental', nombre: 'Instrumental', sufijo: 'I', asignable: true },
        { codigo: 'operativo', nombre: 'Operativo', sufijo: 'O', asignable: false },
      ]);
    });
  });

  describe('MAN-001-A: descartar', () => {
    it('exige un motivo; con motivo guarda quién y cuándo; no se descarta dos veces ni se clasifica después', async () => {
      const r = await recibido();
      const url = `/api/operaciones/mantenimiento/reportes/${r.id}`;
      for (const motivo of ['', '   ']) {
        const sin = await http().post(`${url}/descartar`).set(jefe()).send({ motivo });
        expect(sin.status).toBe(400);
        expect(sin.body.code).toBe('MOTIVO_OBLIGATORIO');
      }
      const ok = await http()
        .post(`${url}/descartar`)
        .set(jefe())
        .send({ motivo: 'Es el desgaste normal del equipo' });
      expect(ok.status).toBe(201);
      expect(ok.body).toMatchObject({
        estado: 'descartado',
        descarte: {
          motivo: 'Es el desgaste normal del equipo',
          por: { id: JEFE.id, nombre: JEFE.nombre },
        },
      });
      const otra = await http().post(`${url}/descartar`).set(jefe()).send({ motivo: 'otra vez' });
      expect(otra.status).toBe(409);
      expect(otra.body.code).toBe('REPORTE_YA_DESCARTADO');
      const clasificar = await http()
        .post(`${url}/clasificar`)
        .set(jefe())
        .send({ asignaciones: [{ tipo: 'mecanico' }] });
      expect(clasificar.status).toBe(409);
      expect(clasificar.body.code).toBe('REPORTE_DESCARTADO');
    });

    it('la base impide un descarte sin motivo o sin quien lo hizo', async () => {
      const r = await recibido();
      await expect(
        admin.query(
          "UPDATE mantenimiento.reporte_recibido SET descartado_at = now(), descartado_por = $2, motivo_descarte = '  ' WHERE id = $1",
          [r.id, JEFE.id],
        ),
      ).rejects.toThrow(/reporte_recibido_descarte_check/);
      await expect(
        admin.query(
          "UPDATE mantenimiento.reporte_recibido SET descartado_at = now(), motivo_descarte = 'x' WHERE id = $1",
          [r.id],
        ),
      ).rejects.toThrow(/reporte_recibido_descarte_check/);
    });
  });

  describe('MAN-001-A: clasificar', () => {
    it('genera la orden con una sub-orden por tipo: mecánica y instrumental asignadas, operativa derivada a Pumping', async () => {
      const r = await recibido();
      const res = await http()
        .post(`/api/operaciones/mantenimiento/reportes/${r.id}/clasificar`)
        .set(jefe())
        .send({
          asignaciones: [
            { tipo: 'mecanico', usuarioId: MECANICO.id },
            { tipo: 'instrumental', usuarioId: INSTRUMENTISTA.id },
            { tipo: 'operativo', notaDerivacion: 'Revisar el empaque del tanque' },
          ],
        });
      expect(res.status).toBe(201);
      // el código de la orden es el del reporte y el de cada sub-orden lleva el sufijo del tipo (se obtienen con JOIN, no se guardan)
      expect(res.body.codigo).toBe(r.codigo);
      expect(res.body.estado).toBe('pendiente');
      expect(res.body.unidad).toMatchObject({ id: UNIDAD.id, codigo: UNIDAD.codigo });
      const por = (t: string) =>
        res.body.subordenes.find((s: { tipo: { codigo: string } }) => s.tipo.codigo === t);
      expect(por('mecanico')).toMatchObject({
        codigo: `${r.codigo}-M`,
        estado: { codigo: 'pendiente' },
        asignada: { id: MECANICO.id, nombre: MECANICO.nombre },
      });
      expect(por('instrumental')).toMatchObject({
        codigo: `${r.codigo}-I`,
        asignada: { id: INSTRUMENTISTA.id },
      });
      expect(por('operativo')).toMatchObject({
        codigo: `${r.codigo}-O`,
        estado: { codigo: 'derivado_a_pumping' },
        asignada: null,
        notaDerivacion: 'Revisar el empaque del tanque',
      });

      const reporte = await http()
        .get(`/api/operaciones/mantenimiento/reportes/${r.id}`)
        .set(jefe());
      expect(reporte.body).toMatchObject({ estado: 'clasificado', ordenId: res.body.id });
      const fila = await prisma.suborden.findMany({
        where: { ordenId: res.body.id },
        include: { tipo: true },
      });
      expect(fila.find((s) => s.tipo.codigo === 'mecanico')?.asignadaPor).toBe(JEFE.id);
    });

    it('el operativo queda pendiente si el Jefe decide no derivarlo todavía; mecánica sin operador queda sin asignar', async () => {
      const r = await recibido();
      const res = await http()
        .post(`/api/operaciones/mantenimiento/reportes/${r.id}/clasificar`)
        .set(jefe())
        .send({ asignaciones: [{ tipo: 'operativo', derivar: false }, { tipo: 'mecanico' }] });
      expect(res.status).toBe(201);
      for (const s of res.body.subordenes) {
        expect(s.estado.codigo).toBe('pendiente');
        expect(s.asignada).toBeNull();
      }
    });

    it('valida: al menos un tipo, sin repetir, tipo existente, solo operadores de mantenimiento activos, y el operativo no se asigna', async () => {
      const r = await recibido();
      const clasificar = (asignaciones: unknown[]) =>
        http()
          .post(`/api/operaciones/mantenimiento/reportes/${r.id}/clasificar`)
          .set(jefe())
          .send({ asignaciones });
      expect((await clasificar([])).status).toBe(400);
      expect((await clasificar([{ tipo: 'mecanico' }, { tipo: 'mecanico' }])).body.code).toBe(
        'TIPO_REPETIDO',
      );
      expect((await clasificar([{ tipo: 'hidraulico' }])).body.code).toBe('TIPO_INVALIDO');
      expect((await clasificar([{ tipo: 'mecanico', usuarioId: OPERADOR.id }])).body.code).toBe(
        'OPERADOR_INVALIDO',
      );
      expect(
        (await clasificar([{ tipo: 'mecanico', usuarioId: MECANICO_INACTIVO.id }])).body.code,
      ).toBe('OPERADOR_INVALIDO');
      expect((await clasificar([{ tipo: 'mecanico', usuarioId: uuidv7() }])).body.code).toBe(
        'OPERADOR_INVALIDO',
      );
      expect((await clasificar([{ tipo: 'operativo', usuarioId: MECANICO.id }])).body.code).toBe(
        'TIPO_NO_ASIGNABLE',
      );
      expect((await clasificar([{ tipo: 'mecanico', derivar: true }])).body.code).toBe(
        'DERIVACION_INVALIDA',
      );
      // nada de lo anterior dejó una orden
      expect(await prisma.orden.count({ where: { reporteId: r.id } })).toBe(0);
    });

    it('un reporte se clasifica una sola vez; una orden no admite descartar su reporte', async () => {
      const r = await recibido();
      const url = `/api/operaciones/mantenimiento/reportes/${r.id}`;
      const ok = await http()
        .post(`${url}/clasificar`)
        .set(jefe())
        .send({ asignaciones: [{ tipo: 'mecanico' }] });
      expect(ok.status).toBe(201);
      const otra = await http()
        .post(`${url}/clasificar`)
        .set(jefe())
        .send({ asignaciones: [{ tipo: 'mecanico' }] });
      expect(otra.status).toBe(409);
      expect(otra.body.code).toBe('REPORTE_CON_ORDEN');
      const descartar = await http().post(`${url}/descartar`).set(jefe()).send({ motivo: 'ya no' });
      expect(descartar.status).toBe(409);
      expect(descartar.body.code).toBe('REPORTE_CON_ORDEN');
    });

    it('publica la orden creada (con ids) y avisa al operador asignado y a Pumping por la derivación', async () => {
      const r = await recibido();
      const res = await http()
        .post(`/api/operaciones/mantenimiento/reportes/${r.id}/clasificar`)
        .set(jefe())
        .send({
          asignaciones: [{ tipo: 'mecanico', usuarioId: MECANICO.id }, { tipo: 'operativo' }],
        });
      const eventosOrden = await admin.query(
        "SELECT tipo, datos->'data' AS d FROM msg_operaciones.outbox WHERE datos->'data'->>'ordenId' = $1 ORDER BY tipo",
        [res.body.id],
      );
      expect(eventosOrden.rows.map((e: { tipo: string }) => e.tipo)).toEqual([
        'operaciones.mantenimiento.orden.creada',
        'operaciones.mantenimiento.suborden.asignada',
        'operaciones.mantenimiento.suborden.derivada_a_pumping',
      ]);
      const asignada = eventosOrden.rows.find(
        (e: { tipo: string }) => e.tipo === 'operaciones.mantenimiento.suborden.asignada',
      );
      expect(asignada.d.asignados).toEqual([
        { usuarioId: MECANICO.id, rolCodigo: 'operador_mantenimiento' },
      ]);
      const creada = eventosOrden.rows.find(
        (e: { tipo: string }) => e.tipo === 'operaciones.mantenimiento.orden.creada',
      );
      expect(creada.d).toMatchObject({ codigo: r.codigo, unidadId: UNIDAD.id });
      expect(creada.d.ticketId).toEqual(expect.any(String));
    });
  });

  describe('reclasificar y consultar', () => {
    it('conserva las sub-órdenes cerradas, quita las que ya no aplican, crea las nuevas y reasigna', async () => {
      const r = await recibido();
      const base = await http()
        .post(`/api/operaciones/mantenimiento/reportes/${r.id}/clasificar`)
        .set(jefe())
        .send({
          asignaciones: [
            { tipo: 'mecanico', usuarioId: MECANICO.id },
            { tipo: 'instrumental', usuarioId: INSTRUMENTISTA.id },
          ],
        });
      expect(base.status).toBe(201);
      // M2 todavía no existe: el trabajo ya aprobado se deja en la base como lo dejará la revisión de cierre
      await admin.query(
        "UPDATE mantenimiento.suborden SET estado_id = (SELECT id FROM mantenimiento.estado_suborden WHERE codigo = 'cerrado') WHERE orden_id = $1 AND tipo_id = (SELECT id FROM mantenimiento.tipo_suborden WHERE codigo = 'mecanico')",
        [base.body.id],
      );
      const res = await http()
        .put(`/api/operaciones/mantenimiento/ordenes/${base.body.id}/clasificacion`)
        .set(jefe())
        .send({
          asignaciones: [{ tipo: 'operativo' }], // se destilda mecánico (cerrado: se conserva) e instrumental (se quita)
        });
      expect(res.status).toBe(200);
      expect(res.body.subordenes.map((s: { tipo: { codigo: string } }) => s.tipo.codigo)).toEqual([
        'mecanico',
        'operativo',
      ]);
      expect(res.body.subordenes[0].estado.codigo).toBe('cerrado');
      expect(res.body.subordenes[1].estado.codigo).toBe('derivado_a_pumping');
      // todas resueltas (cerrada y derivada): la orden queda aceptada
      expect(res.body.estado).toBe('aceptada');

      const reasignada = await http()
        .put(`/api/operaciones/mantenimiento/ordenes/${base.body.id}/clasificacion`)
        .set(jefe())
        .send({
          asignaciones: [{ tipo: 'operativo' }, { tipo: 'instrumental', usuarioId: MECANICO.id }],
        });
      expect(reasignada.status).toBe(200);
      const ins = reasignada.body.subordenes.find(
        (s: { tipo: { codigo: string } }) => s.tipo.codigo === 'instrumental',
      );
      expect(ins.asignada.id).toBe(MECANICO.id);
      expect(reasignada.body.estado).toBe('pendiente');
    });

    it('no reclasifica una orden cuya unidad ya volvió a operación', async () => {
      const r = await recibido();
      const base = await http()
        .post(`/api/operaciones/mantenimiento/reportes/${r.id}/clasificar`)
        .set(jefe())
        .send({ asignaciones: [{ tipo: 'mecanico' }] });
      await admin.query(
        "UPDATE mantenimiento.orden SET retornada_at = now(), retornada_por = $2, estado_final = 'disponible' WHERE id = $1",
        [base.body.id, JEFE.id],
      );
      const res = await http()
        .put(`/api/operaciones/mantenimiento/ordenes/${base.body.id}/clasificacion`)
        .set(jefe())
        .send({ asignaciones: [{ tipo: 'instrumental' }] });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('ORDEN_CERRADA');
      const orden = await http()
        .get(`/api/operaciones/mantenimiento/ordenes/${base.body.id}`)
        .set(jefe());
      expect(orden.body.estado).toBe('cerrada');
      expect(orden.body.retorno).toMatchObject({ estadoFinal: 'disponible' });
    });

    it('lista las órdenes por estado, unidad y operador asignado, y las sub-órdenes de la unidad (tarjeta del ticket)', async () => {
      const r = await recibido();
      const o = await http()
        .post(`/api/operaciones/mantenimiento/reportes/${r.id}/clasificar`)
        .set(jefe())
        .send({ asignaciones: [{ tipo: 'instrumental', usuarioId: INSTRUMENTISTA.id }] });
      const mias = await http()
        .get(`/api/operaciones/mantenimiento/ordenes?asignadaA=${INSTRUMENTISTA.id}`)
        .set(jefe());
      expect(mias.body.map((x: { id: string }) => x.id)).toContain(o.body.id);
      const deOtro = await http()
        .get(`/api/operaciones/mantenimiento/ordenes?asignadaA=${MECANICO_INACTIVO.id}`)
        .set(jefe());
      expect(deOtro.body.map((x: { id: string }) => x.id)).not.toContain(o.body.id);
      const porEstado = await http()
        .get(`/api/operaciones/mantenimiento/ordenes?estado=aceptada&unidadId=${UNIDAD.id}`)
        .set(jefe());
      expect(porEstado.body.map((x: { id: string }) => x.id)).not.toContain(o.body.id);

      const tarjeta = await http()
        .get(`/api/operaciones/mantenimiento/unidades/${UNIDAD.id}/subordenes`)
        .set(soloLectura());
      expect(tarjeta.status).toBe(200);
      expect(tarjeta.body).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            codigo: `${r.codigo}-I`,
            ordenId: o.body.id,
            tipo: { codigo: 'instrumental', nombre: 'Instrumental' },
            estado: { codigo: 'pendiente', nombre: 'Pendiente' },
          }),
        ]),
      );
    });
  });

  describe('camino completo y reglas de la base', () => {
    it('camino completo: reporte de Pumping, evento, reporte recibido y orden, con la auditoría de quién lo hizo', async () => {
      const { reporteId, ticketId } = await reportePumping({
        instrumentacion: 'Monitor sin lectura',
      });
      await consumer.consumir(evento(reporteId, { ticketId, vehiculoId: VEHICULO.id }));
      const r = await prisma.reporteRecibido.findUniqueOrThrow({
        where: { pumpingReporteUnidadId: reporteId },
      });
      expect(r).toMatchObject({ createdBy: OPERADOR.id, updatedBy: OPERADOR.id });
      const o = await http()
        .post(`/api/operaciones/mantenimiento/reportes/${r.id}/clasificar`)
        .set(jefe())
        .send({ asignaciones: [{ tipo: 'instrumental', usuarioId: INSTRUMENTISTA.id }] });
      expect(o.status).toBe(201);
      const fila = await admin.query(
        `SELECT r.codigo, p.ticket_id, u.codigo AS unidad, o.created_by
           FROM mantenimiento.orden o
           JOIN mantenimiento.reporte_recibido r ON r.id = o.reporte_id
           JOIN pumping.reporte_unidad p ON p.id = r.pumping_reporte_unidad_id
           JOIN flota.unidad u ON u.id = r.unidad_id
          WHERE o.id = $1`,
        [o.body.id],
      );
      expect(fila.rows[0]).toMatchObject({
        codigo: r.codigo,
        ticket_id: ticketId,
        unidad: UNIDAD.codigo,
        created_by: JEFE.id,
      });
      const auditado = await prisma.reporteRecibido.findUniqueOrThrow({ where: { id: r.id } });
      expect(auditado.updatedBy).toBe(OPERADOR.id);
    });

    it('descartar deja quién lo descartó como autor de la última edición', async () => {
      const r = await recibido();
      await http()
        .post(`/api/operaciones/mantenimiento/reportes/${r.id}/descartar`)
        .set(jefe())
        .send({ motivo: 'Normal' });
      expect(
        (await prisma.reporteRecibido.findUniqueOrThrow({ where: { id: r.id } })).updatedBy,
      ).toBe(JEFE.id);
    });

    it('la base rechaza: origen sin su referencia, un tipo repetido en la orden, repuestos inválidos o repetidos y una transición a sí misma', async () => {
      const r = await recibido();
      // origen Pumping sin el reporte de Pumping; origen QHSE sin caso ni texto
      await expect(
        admin.query(
          "INSERT INTO mantenimiento.reporte_recibido (id, codigo, origen, unidad_id) VALUES ($1, $2, 'pumping', $3)",
          [uuidv7(), `RX${n}`, UNIDAD.id],
        ),
      ).rejects.toThrow(/reporte_recibido_origen_check/);
      await expect(
        admin.query(
          "INSERT INTO mantenimiento.reporte_recibido (id, codigo, origen, unidad_id, qhse_referencia_id) VALUES ($1, $2, 'qhse', $3, $4)",
          [uuidv7(), `RY${n}`, UNIDAD.id, uuidv7()],
        ),
      ).rejects.toThrow(/reporte_recibido_origen_check/);

      const o = await http()
        .post(`/api/operaciones/mantenimiento/reportes/${r.id}/clasificar`)
        .set(jefe())
        .send({ asignaciones: [{ tipo: 'mecanico' }] });
      const subId = o.body.subordenes[0].id as string;
      const dup = (tipo: string) =>
        admin.query(
          `INSERT INTO mantenimiento.suborden (id, orden_id, tipo_id, estado_id)
           SELECT $1, $2, t.id, e.id FROM mantenimiento.tipo_suborden t, mantenimiento.estado_suborden e WHERE t.codigo = $3 AND e.codigo = 'pendiente'`,
          [uuidv7(), o.body.id, tipo],
        );
      await expect(dup('mecanico')).rejects.toThrow(/suborden_orden_tipo_key/);

      const repuesto = (parte: string, cantidad: number) =>
        admin.query(
          'INSERT INTO mantenimiento.suborden_repuesto (id, suborden_id, numero_parte, cantidad) VALUES ($1, $2, $3, $4)',
          [uuidv7(), subId, parte, cantidad],
        );
      await repuesto('P-100', 2);
      await expect(repuesto('P-100', 1)).rejects.toThrow(/suborden_repuesto_parte_key/);
      await expect(repuesto('P-101', 0)).rejects.toThrow(/suborden_repuesto_cantidad_check/);
      await expect(repuesto('   ', 1)).rejects.toThrow(/suborden_repuesto_parte_check/);
      const deCatalogo = (
        articuloId: string,
        bodegaId: string | null,
        parte: string | null = null,
      ) =>
        admin.query(
          'INSERT INTO mantenimiento.suborden_repuesto (id, suborden_id, numero_parte, cantidad, articulo_id, bodega_id) VALUES ($1, $2, $3, 1, $4, $5)',
          [uuidv7(), subId, parte, articuloId, bodegaId],
        );
      await expect(deCatalogo(uuidv7(), BODEGA.id)).rejects.toThrow(
        /suborden_repuesto_articulo_fkey/,
      );
      await expect(deCatalogo(ARTICULO.id, uuidv7())).rejects.toThrow(
        /suborden_repuesto_bodega_fkey/,
      );
      // de catálogo = artículo + bodega y sin texto; de texto = parte y sin artículo ni bodega
      await expect(deCatalogo(ARTICULO.id, null)).rejects.toThrow(/suborden_repuesto_origen_check/);
      await expect(deCatalogo(ARTICULO.id, BODEGA.id, 'P-103')).rejects.toThrow(
        /suborden_repuesto_origen_check/,
      );
      await expect(
        admin.query(
          'INSERT INTO mantenimiento.suborden_repuesto (id, suborden_id, cantidad) VALUES ($1, $2, 1)',
          [uuidv7(), subId],
        ),
      ).rejects.toThrow(/suborden_repuesto_origen_check/);
      await deCatalogo(ARTICULO.id, BODEGA.id);
      await expect(deCatalogo(ARTICULO.id, BODEGA.id)).rejects.toThrow(
        /suborden_repuesto_articulo_key/,
      );

      await expect(
        admin.query(
          "INSERT INTO mantenimiento.transicion_suborden (id, origen_id, destino_id) SELECT $1, id, id FROM mantenimiento.estado_suborden WHERE codigo = 'pendiente'",
          [uuidv7()],
        ),
      ).rejects.toThrow(/transicion_suborden_distinta_check/);
      // un tipo o un estado en uso no se puede borrar
      await expect(
        admin.query("DELETE FROM mantenimiento.tipo_suborden WHERE codigo = 'mecanico'"),
      ).rejects.toThrow(/violates foreign key/);
    });

    it('el rol de la aplicación no puede borrar reportes ni órdenes (la historia no se reescribe)', async () => {
      const app = new Pool({ connectionString: APP_DB.replace('?pgbouncer=true', ''), max: 1 });
      try {
        const r = await recibido();
        await expect(
          app.query('DELETE FROM mantenimiento.reporte_recibido WHERE id = $1', [r.id]),
        ).rejects.toThrow(/permission denied/);
        await expect(app.query('DELETE FROM mantenimiento.orden')).rejects.toThrow(
          /permission denied/,
        );
      } finally {
        await app.end();
      }
    });
  });

  describe('el número del reporte', () => {
    it('es consecutivo y no se repite aunque lleguen 25 reportes a la vez', async () => {
      const reportes = await Promise.all(
        Array.from({ length: 25 }, async () => {
          const { reporteId } = await reportePumping();
          await consumer.consumir(evento(reporteId));
          return prisma.reporteRecibido.findUniqueOrThrow({
            where: { pumpingReporteUnidadId: reporteId },
          });
        }),
      );
      const codigos = reportes.map((r) => r.codigo);
      expect(new Set(codigos).size).toBe(25);
      const numeros = codigos.map((c) => Number(c.slice(1))).sort((a, b) => a - b);
      expect(numeros[24] - numeros[0]).toBe(24);
    });
  });
  describe('ejecución y cierre de la sub-orden, con repuestos del catálogo (M2)', () => {
    const base = '/api/operaciones/mantenimiento';
    const stockDe = async () =>
      Number(
        (
          await admin.query(
            'SELECT saldo_resultante FROM inventario.movimiento WHERE articulo_id = $1 AND bodega_id = $2 ORDER BY secuencia DESC LIMIT 1',
            [ARTICULO.id, BODEGA.id],
          )
        ).rows[0].saldo_resultante,
      );

    /** Una orden con la sub-orden mecánica asignada a MECANICO; devuelve el id de la sub-orden. */
    const subordenMecanica = async () => {
      const r = await recibido();
      const o = await http()
        .post(`${base}/reportes/${r.id}/clasificar`)
        .set(jefe())
        .send({ asignaciones: [{ tipo: 'mecanico', usuarioId: MECANICO.id }] });
      expect(o.status).toBe(201);
      return o.body.subordenes[0].id as string;
    };
    const avance = (id: string, body: object, auth = mecanico()) =>
      http().put(`${base}/subordenes/${id}/avance`).set(auth).send(body);
    const enviar = (id: string) =>
      http().post(`${base}/subordenes/${id}/enviar-revision`).set(mecanico());
    const aprobar = (id: string, auth = jefe()) =>
      http().post(`${base}/subordenes/${id}/aprobar-cierre`).set(auth);
    const corregir = (id: string, nota: string) =>
      http().post(`${base}/subordenes/${id}/solicitar-correccion`).set(jefe()).send({ nota });

    it('el operador elige el repuesto del catálogo, el Jefe aprueba y la salida queda en el kardex', async () => {
      const id = await subordenMecanica();
      const guardado = await avance(id, {
        diagnostico: 'Filtro saturado',
        actividadesCorrectivas: 'Cambio de filtro de aceite',
        horasTrabajo: 1.5,
        repuestos: [
          { articuloId: ARTICULO.id, bodegaId: BODEGA.id, cantidad: 3 },
          { numeroParte: 'XZ-900', descripcion: 'Empaque sin código en Inventario', cantidad: 1 },
        ],
      });
      expect(guardado.status).toBe(200);
      expect(guardado.body.estado.codigo).toBe('en_ejecucion');
      expect(guardado.body.repuestos).toHaveLength(2);
      expect(guardado.body.repuestos[0]).toMatchObject({
        cantidad: 3,
        articulo: { id: ARTICULO.id, codigo: ARTICULO.codigo },
        bodega: { id: BODEGA.id },
        numeroParte: null,
        movimientoId: null,
      });
      expect(await stockDe()).toBe(20); // guardar el avance no mueve el stock

      const enviada = await enviar(id);
      expect(enviada.status).toBe(201);
      expect(enviada.body.estado.codigo).toBe('en_revision_cierre');
      expect(await stockDe()).toBe(20);

      const cerrada = await aprobar(id);
      expect(cerrada.status).toBe(201);
      expect(cerrada.body.estado.codigo).toBe('cerrado');
      expect(await stockDe()).toBe(17);
      const catalogo = cerrada.body.repuestos.find((x: { articulo: unknown }) => x.articulo);
      const texto = cerrada.body.repuestos.find(
        (x: { numeroParte: string | null }) => x.numeroParte,
      );
      expect(catalogo.movimientoId).toEqual(expect.any(String));
      expect(texto.movimientoId).toBeNull(); // el de texto no existe en Inventario: no sale nada

      const m = (
        await admin.query(
          `SELECT m.tipo, m.origen, m.cantidad, m.bodega_id, mo.nombre AS motivo, s.suborden_repuesto_id
             FROM inventario.movimiento m
             JOIN inventario.motivo_movimiento mo ON mo.id = m.motivo_id
             JOIN inventario.salida_mantenimiento s ON s.movimiento_id = m.id
            WHERE m.id = $1`,
          [catalogo.movimientoId],
        )
      ).rows[0];
      expect(m).toMatchObject({
        tipo: 'salida',
        origen: 'consumo_mantenimiento',
        bodega_id: BODEGA.id,
        motivo: 'Consumo en mantenimiento',
        suborden_repuesto_id: catalogo.id,
      });
      expect(Number(m.cantidad)).toBe(3);

      // la orden trae sus sub-órdenes completas (lo que muestra la bandeja del Jefe), no solo el estado
      const orden = await http().get(`${base}/ordenes/${cerrada.body.ordenId}`).set(jefe());
      expect(orden.body.subordenes[0]).toMatchObject({
        id,
        diagnostico: 'Filtro saturado',
        horasTrabajo: 1.5,
        asignada: { id: MECANICO.id },
        asignadaPor: { id: JEFE.id },
        estado: { codigo: 'cerrado' },
      });
      expect(orden.body.subordenes[0].repuestos).toHaveLength(2);
      expect(orden.body.subordenes[0].cierreAprobadoAt).toEqual(expect.any(String));

      // fin correctivo: con la única sub-orden cerrada, el Jefe devuelve la unidad (una sola vez)
      expect(
        (
          await http()
            .post(`${base}/ordenes/${cerrada.body.ordenId}/retornar`)
            .set(mecanico())
            .send({ estadoFinal: 'disponible' })
        ).status,
      ).toBe(403);
      const retorno = await http()
        .post(`${base}/ordenes/${cerrada.body.ordenId}/retornar`)
        .set(jefe())
        .send({ estadoFinal: 'con_restricciones', observaciones: 'Operar sin la bomba auxiliar' });
      expect(retorno.status).toBe(201);
      expect(retorno.body).toMatchObject({
        estado: 'cerrada',
        retorno: {
          por: JEFE.id,
          estadoFinal: 'con_restricciones',
          observaciones: 'Operar sin la bomba auxiliar',
        },
      });
      expect(
        (
          await http()
            .post(`${base}/ordenes/${cerrada.body.ordenId}/retornar`)
            .set(jefe())
            .send({ estadoFinal: 'disponible' })
        ).status,
      ).toBe(409);

      // el renglón con salida ya no se puede cambiar ni borrar (ni siquiera la base lo permite)
      await expect(
        admin.query('UPDATE mantenimiento.suborden_repuesto SET cantidad = 9 WHERE id = $1', [
          catalogo.id,
        ]),
      ).rejects.toThrow(/ya salió de bodega/);
      await expect(
        admin.query('DELETE FROM mantenimiento.suborden_repuesto WHERE id = $1', [catalogo.id]),
      ).rejects.toThrow(/ya salió de bodega/);
      // una sub-orden cerrada no se vuelve a editar
      expect((await avance(id, { diagnostico: 'otro' })).status).toBe(409);
    });

    it('no se devuelve la unidad mientras haya sub-órdenes sin resolver', async () => {
      const id = await subordenMecanica();
      const orden = await http().get(`${base}/subordenes/${id}`).set(jefe());
      const r = await http()
        .post(`${base}/ordenes/${orden.body.ordenId}/retornar`)
        .set(jefe())
        .send({ estadoFinal: 'disponible' });
      expect(r.status).toBe(409);
      expect(r.body.code ?? r.body.message).toBeDefined();
      expect(
        (
          await http()
            .post(`${base}/ordenes/${orden.body.ordenId}/retornar`)
            .set(jefe())
            .send({ estadoFinal: 'roto' })
        ).status,
      ).toBe(400);
    });

    it('la corrección devuelve la sub-orden al operador, que puede volver a enviarla', async () => {
      const id = await subordenMecanica();
      await avance(id, { actividadesCorrectivas: 'Ajuste de correa' });
      expect((await enviar(id)).status).toBe(201);

      expect((await corregir(id, '   ')).status).toBe(400);
      const pedida = await corregir(id, 'Falta el torque de la correa');
      expect(pedida.status).toBe(201);
      expect(pedida.body).toMatchObject({
        estado: { codigo: 'correccion_solicitada' },
        notaCorreccion: 'Falta el torque de la correa',
      });

      const corregida = await avance(id, { actividadesCorrectivas: 'Ajuste de correa a 40 N·m' });
      expect(corregida.body.estado.codigo).toBe('en_ejecucion');
      expect((await enviar(id)).status).toBe(201);
    });

    it('aplica las reglas: quién puede actuar, el orden de los pasos y qué repuestos se aceptan', async () => {
      const id = await subordenMecanica();
      // otra cuenta de operador no toca una sub-orden ajena
      expect((await avance(id, { diagnostico: 'x' }, mecanico(INSTRUMENTISTA.id))).status).toBe(
        403,
      );
      // no se envía a revisión sin actividades, ni se aprueba lo que no está en revisión
      expect((await enviar(id)).status).toBe(400);
      expect((await aprobar(id)).status).toBe(409);
      // el operador no aprueba
      expect((await aprobar(id, mecanico())).status).toBe(403);

      const malos: Array<[string, object[]]> = [
        [
          'mezcla catálogo y texto',
          [{ articuloId: ARTICULO.id, bodegaId: BODEGA.id, numeroParte: 'A', cantidad: 1 }],
        ],
        ['catálogo sin bodega', [{ articuloId: ARTICULO.id, cantidad: 1 }]],
        ['bodega que no existe', [{ articuloId: ARTICULO.id, bodegaId: uuidv7(), cantidad: 1 }]],
        ['artículo que no existe', [{ articuloId: uuidv7(), bodegaId: BODEGA.id, cantidad: 1 }]],
        ['sin artículo ni parte', [{ cantidad: 1 }]],
        [
          'artículo repetido',
          [
            { articuloId: ARTICULO.id, bodegaId: BODEGA.id, cantidad: 1 },
            { articuloId: ARTICULO.id, bodegaId: BODEGA.id, cantidad: 2 },
          ],
        ],
        [
          'parte repetida',
          [
            { numeroParte: 'A-1', cantidad: 1 },
            { numeroParte: ' A-1 ', cantidad: 1 },
          ],
        ],
        ['cantidad cero', [{ numeroParte: 'A-2', cantidad: 0 }]],
      ];
      for (const [caso, repuestos] of malos) {
        const r = await avance(id, { repuestos });
        expect({ caso, status: r.status }).toEqual({ caso, status: 400 });
      }
      // nada de lo rechazado quedó guardado
      const s = await http().get(`${base}/subordenes/${id}`).set(jefe());
      expect(s.body.repuestos).toHaveLength(0);
    });

    it('si no alcanza el stock, el cierre se rechaza y no cambia nada; al corregir la cantidad se puede aprobar', async () => {
      const id = await subordenMecanica();
      await avance(id, {
        actividadesCorrectivas: 'Cambio masivo',
        repuestos: [{ articuloId: ARTICULO.id, bodegaId: BODEGA.id, cantidad: 500 }],
      });
      expect((await enviar(id)).status).toBe(201);
      const antes = await stockDe();

      expect((await aprobar(id)).status).toBe(409);
      expect(await stockDe()).toBe(antes);
      const s = await http().get(`${base}/subordenes/${id}`).set(jefe());
      expect(s.body.estado.codigo).toBe('en_revision_cierre');
      expect(s.body.repuestos[0].movimientoId).toBeNull();

      expect((await corregir(id, 'Verifique la cantidad')).status).toBe(201);
      await avance(id, {
        repuestos: [{ articuloId: ARTICULO.id, bodegaId: BODEGA.id, cantidad: 2 }],
      });
      expect((await enviar(id)).status).toBe(201);
      expect((await aprobar(id)).status).toBe(201);
      expect(await stockDe()).toBe(antes - 2);
    });

    it('la salida de un renglón es idempotente: repetirla no vuelve a descontar', async () => {
      const inventario = app.get(MovimientosService);
      const antes = await stockDe();
      const linea = {
        subordenRepuestoId: uuidv7(),
        articuloId: ARTICULO.id,
        bodegaId: BODEGA.id,
        cantidad: 1,
      };
      const actor = { id: JEFE.id, roleCode: 'jefe_mantenimiento' as const };
      const a = await inventario.registrarSalidasDeMantenimiento([linea], actor);
      const b = await inventario.registrarSalidasDeMantenimiento([linea], actor);
      expect(b.get(linea.subordenRepuestoId)).toBe(a.get(linea.subordenRepuestoId));
      expect(await stockDe()).toBe(antes - 1);
    });

    it('el selector de repuestos busca por código o nombre y muestra la existencia por bodega', async () => {
      const buscar = (q: string, auth = mecanico()) =>
        http().get('/api/operaciones/inventario/articulos/repuestos').query({ q }).set(auth);
      const r = await buscar(ARTICULO.codigo.toLowerCase());
      expect(r.status).toBe(200);
      expect(r.body).toHaveLength(1);
      const stock = await stockDe();
      expect(r.body[0]).toMatchObject({
        id: ARTICULO.id,
        codigo: ARTICULO.codigo,
        stockActual: stock,
        porBodega: [{ bodegaId: BODEGA.id, bodega: BODEGA.nombre, stock }],
      });
      // con menos de 2 letras no busca; sin permiso, no entra
      expect((await buscar('a')).body).toEqual([]);
      expect((await buscar('ab', sinPermiso())).status).toBe(403);
    });
  });
});
