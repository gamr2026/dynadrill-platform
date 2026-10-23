/**
 * Integración real de Flota (tramos F2 y F3): documentos de los conductores e inspección de vehículos (DYN-SGI-RE-068), con su caso por
 * ticket, la revisión del Supervisor, los eventos del contrato 3 y las reglas que garantiza la base. Limpia lo que crea.
 *   RUN_INTEGRATION=1 npx jest --config libs/operaciones/flota/jest.config.cts
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
import { createEvent, MessagingModule } from '@dyn/messaging';
import { uuidv7 } from '@dyn/utils';
import { AsignacionPumpingConsumer } from './consumers/asignacion-pumping.consumer';
import { FlotaModule } from './flota.module';
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
const dia = (d: Date) => d.toISOString().slice(0, 10);
// Los días se cuentan en hora de Ecuador, como el servicio: de noche la fecha UTC ya es la de mañana.
const enDias = (k: number) => {
  const hoyEc = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Guayaquil' }).format(
    new Date(),
  );
  return dia(new Date(Date.parse(`${hoyEc}T00:00:00Z`) + k * 86_400_000));
};

const JEFE = { id: uuidv7(), nombre: 'Mario Jefe Mantenimiento' };
const SUPERVISOR = { id: uuidv7(), nombre: 'Sara Supervisora' };
const OPERADOR = { id: uuidv7(), nombre: 'Oscar Operador' };
const CONDUCTOR = { id: uuidv7(), nombre: 'Carlos Conductor' };
const CONDUCTOR_SIN = { id: uuidv7(), nombre: 'Cesar Sin Documentos' };
const VEHICULO = { id: uuidv7(), placa: `IN${String(n).slice(-5)}A` };
const VEHICULO_2 = { id: uuidv7(), placa: `IN${String(n).slice(-5)}B` };
const MAESTROS: MaestrosDePrueba = {
  usuarios: [
    { id: JEFE.id, nombre: JEFE.nombre, rol: 'jefe_mantenimiento' },
    { id: SUPERVISOR.id, nombre: SUPERVISOR.nombre, rol: 'supervisor_pumping' },
    { id: OPERADOR.id, nombre: OPERADOR.nombre, rol: 'operador' },
    { id: CONDUCTOR.id, nombre: CONDUCTOR.nombre, rol: 'conductor' },
    { id: CONDUCTOR_SIN.id, nombre: CONDUCTOR_SIN.nombre, rol: 'conductor' },
  ],
  vehiculos: [VEHICULO, VEHICULO_2],
};

const PERMISOS_JEFE = [
  P.UNIDADES_VER,
  P.UNIDADES_CREAR,
  P.INSPECCIONES_VER,
  P.INSPECCIONES_CREAR,
  P.INSPECCIONES_ANULAR,
  P.CONDUCTORES_VER,
  P.CONDUCTORES_GESTIONAR,
];
const PERMISOS_SUPERVISOR = [P.INSPECCIONES_VER, P.INSPECCIONES_APROBAR, P.CONDUCTORES_VER];
const PERMISOS_OPERADOR = [P.INSPECCIONES_VER, P.INSPECCIONES_CREAR, P.CONDUCTORES_VER];

run('Flota F2/F3: conductores e inspección de vehículos (base de datos real)', () => {
  jest.setTimeout(180000);
  let app: INestApplication;
  const admin = new Pool({ connectionString: MIGRATOR_DB, max: 2 });
  const appDb = new Pool({
    connectionString: APP_DB.replace('?pgbouncer=true', ''),
    max: 2,
  });
  const http = () => request(app.getHttpServer());
  const signer = new JwtService({
    privateKey,
    signOptions: { algorithm: 'RS256', issuer: 'dynadrill-plataforma', expiresIn: 600 },
  });
  const token = (roleCode: string, name: string, permissions: string[], sub: string) => ({
    Authorization: `Bearer ${signer.sign({ sub, email: `${roleCode}@test.local`, name, roleId: 'r', roleCode, permissions })}`,
  });
  const jefe = () => token('jefe_mantenimiento', JEFE.nombre, PERMISOS_JEFE, JEFE.id);
  const supervisor = () =>
    token('supervisor_pumping', SUPERVISOR.nombre, PERMISOS_SUPERVISOR, SUPERVISOR.id);
  const operador = () => token('operador', OPERADOR.nombre, PERMISOS_OPERADOR, OPERADOR.id);

  const base = '/api/operaciones/flota';
  const ticketId = uuidv7();
  const eventosEnviados: string[] = [];
  const unidades: string[] = [];
  let unidadId = '';
  let unidad2Id = '';
  let items: Array<{ id: string; codigo: string; seccion: string }> = [];
  let tipos: Array<{ id: string; codigo: string; conVigencia: boolean }> = [];

  const todoCumple = () => items.map((i) => ({ itemId: i.id, resultado: 'cumple' }));
  const conCinturon = (resultado: string) =>
    items.map((i) => ({
      itemId: i.id,
      resultado: i.codigo === 'cinturones' ? resultado : 'cumple',
    }));
  const asignacion = (
    pares: Array<{ usuarioId: string; vehiculoId?: string | null; unidadId?: string | null }>,
  ) => {
    const e = createEvent({
      type: 'operaciones.pumping.asignacion_realizada',
      source: 'operaciones',
      subject: { type: 'pumping_ticket', id: ticketId },
      data: {
        ticketId,
        operadoresUnidades: pares,
        asignados: [{ usuarioId: SUPERVISOR.id, rolCodigo: 'supervisor' }],
      },
      actor: { userId: SUPERVISOR.id, role: 'supervisor_pumping' },
    });
    eventosEnviados.push(e.id);
    return app.get(AsignacionPumpingConsumer).consumir(e);
  };
  const casos = async () =>
    (
      await http()
        .get(`${base}/inspecciones-vehiculo/casos?ticketId=${ticketId}`)
        .set(operador())
        .expect(200)
    ).body as Array<{
      id: string;
      estado: string;
      llegadaInspeccionId: string | null;
      operador: { id: string };
      unidad: { id: string };
    }>;
  const registrar = (cuerpo: Record<string, unknown>, quien = operador()) =>
    http().post(`${base}/inspecciones-vehiculo`).set(quien).send(cuerpo);
  const eventos = async (tipo: string, inspeccionId: string) =>
    (
      await admin.query(
        "SELECT datos->'data' AS data FROM msg_operaciones.outbox WHERE tipo = $1 AND datos->'data'->>'inspeccionId' = $2",
        [tipo, inspeccionId],
      )
    ).rows.map((r: { data: Record<string, unknown> }) => r.data);
  const permiso = (usuarioId: string, tipo: string, hasta?: string) => {
    const t = tipos.find((x) => x.codigo === tipo)!;
    return http()
      .post(`${base}/conductores/${usuarioId}/permisos`)
      .set(jefe())
      .send({ tipoId: t.id, ...(hasta ? { vigenteHasta: hasta } : {}) });
  };
  const rechazoDeBase = async (promesa: Promise<unknown>) => {
    let error: unknown = null;
    try {
      await promesa;
    } catch (e) {
      error = e;
    }
    expect(error).not.toBeNull();
    return String((error as { message?: string }).message);
  };

  beforeAll(async () => {
    // Sin RabbitMQ: no se suscribe; el consumidor se prueba llamando a `consumir` directamente.
    jest.spyOn(AsignacionPumpingConsumer.prototype, 'onApplicationBootstrap').mockResolvedValue();
    await sembrarMaestros(admin, MAESTROS);
    await admin.query(
      "INSERT INTO pumping.ticket (id, pedido_id, pedido_codigo, paso_codigo) VALUES ($1, $2, $3, 'revision_inicial')",
      [ticketId, uuidv7(), `PED-INSP-${n}`],
    );
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
        FlotaModule,
      ],
    })
    class TestAppModule {}
    const mod = await Test.createTestingModule({ imports: [TestAppModule] }).compile();
    app = mod.createNestApplication();
    configureApp(app, { corsOrigins: ['http://localhost:4200'] });
    await app.init();

    for (const [vehiculoId, cod] of [
      [VEHICULO.id, 'A'],
      [VEHICULO_2.id, 'B'],
    ] as const) {
      const r = await http()
        .post(`${base}/unidades`)
        .set(jefe())
        .send({
          codigo: `INS-${String(n).slice(-6)}${cod}`,
          nombre: `Camioneta de prueba ${cod}`,
          tipo: 'transporte',
          categoriaPeso: 'liviano',
          vehiculoId,
          lecturaInicial: 1000,
        })
        .expect(201);
      unidades.push(r.body.id);
    }
    [unidadId, unidad2Id] = unidades;
    items = (await http().get(`${base}/inspecciones-vehiculo/items`).set(operador()).expect(200))
      .body;
    tipos = (await http().get(`${base}/conductores/tipos-permiso`).set(operador()).expect(200))
      .body;
  });

  afterAll(async () => {
    const q = (sql: string, p: unknown[]) => admin.query(sql, p).catch(() => undefined);
    await q('DELETE FROM flota.unidad_lectura WHERE unidad_id = ANY($1::uuid[])', [unidades]);
    await q(
      'DELETE FROM flota.inspeccion_vehiculo_resultado WHERE inspeccion_id IN (SELECT id FROM flota.inspeccion_vehiculo WHERE unidad_id = ANY($1::uuid[]))',
      [unidades],
    );
    await q(
      'DELETE FROM flota.inspeccion_vehiculo_revision WHERE inspeccion_id IN (SELECT id FROM flota.inspeccion_vehiculo WHERE unidad_id = ANY($1::uuid[]))',
      [unidades],
    );
    await q('DELETE FROM flota.inspeccion_vehiculo WHERE unidad_id = ANY($1::uuid[])', [unidades]);
    await q('DELETE FROM flota.inspeccion_caso WHERE ticket_id = $1', [ticketId]);
    await q('DELETE FROM flota.conductor_permiso WHERE usuario_id = ANY($1::uuid[])', [
      [CONDUCTOR.id, CONDUCTOR_SIN.id],
    ]);
    await q(
      "DELETE FROM msg_operaciones.outbox WHERE datos->'data'->>'unidadId' = ANY($1::text[]) OR datos->'data'->>'usuarioId' = ANY($2::text[])",
      [unidades, [CONDUCTOR.id, CONDUCTOR_SIN.id]],
    );
    await q('DELETE FROM msg_operaciones.inbox WHERE id = ANY($1::uuid[])', [eventosEnviados]);
    await q('DELETE FROM flota.unidad WHERE id = ANY($1::uuid[])', [unidades]);
    await q('DELETE FROM pumping.ticket WHERE id = $1', [ticketId]);
    await quitarMaestros(admin, MAESTROS);
    await admin.end();
    await appDb.end();
    await app.close();
  });

  describe('catálogos y permisos', () => {
    it('trae los 30 ítems del formato y 6 tipos de documento; la Nota 1 es una columna', async () => {
      expect(items.filter((i) => i.seccion === 'vehiculo')).toHaveLength(24);
      expect(items.filter((i) => i.seccion === 'equipo')).toHaveLength(6);
      expect(tipos).toHaveLength(6);
      const b = await admin.query(
        'SELECT codigo FROM flota.item_inspeccion_vehiculo WHERE bloquea_si_no_cumple',
      );
      expect(b.rows).toEqual([{ codigo: 'cinturones' }]);
    });

    it('sin token 401; quien no tiene el permiso 403', async () => {
      await http().get(`${base}/inspecciones-vehiculo/items`).expect(401);
      await http()
        .get(`${base}/inspecciones-vehiculo/items`)
        .set(token('ingenieria_ventas', 'Vera', [], uuidv7()))
        .expect(403);
      // la licencia del conductor se registra aquí (con el permiso correcto) para las pruebas que siguen
      await permiso(CONDUCTOR.id, 'licencia', enDias(100)).then((r) => expect(r.status).toBe(201));
      await http()
        .post(`${base}/conductores/${CONDUCTOR.id}/permisos`)
        .set(operador())
        .send({ tipoId: tipos[0].id, vigenteHasta: enDias(10) })
        .expect(403);
      await http()
        .post(`${base}/inspecciones-vehiculo/${uuidv7()}/aprobar`)
        .set(operador())
        .expect(403);
      await http().post(`${base}/inspecciones-vehiculo`).set(supervisor()).send({}).expect(403);
    });
  });

  describe('F2: documentos del conductor', () => {
    it('exige fecha en los documentos que vencen y la prohíbe en los que no', async () => {
      const sinFecha = await permiso(CONDUCTOR.id, 'manejo_defensivo');
      expect([sinFecha.status, sinFecha.body.code]).toEqual([400, 'falta_vigencia']);
      const conFecha = await permiso(CONDUCTOR.id, 'documentos_clientes', enDias(5));
      expect([conFecha.status, conFecha.body.code]).toEqual([400, 'sin_vigencia']);
    });

    it('reúne las condiciones solo con los seis documentos vigentes; el último registrado manda', async () => {
      let e = (await http().get(`${base}/conductores/${CONDUCTOR.id}`).set(operador()).expect(200))
        .body;
      expect(e.reuneCondiciones).toBe(false);
      const falta = e.documentos.filter((d: { estado: string }) => d.estado === 'faltante');
      expect(falta).toHaveLength(5); // la licencia se registró arriba (100 días)

      await permiso(CONDUCTOR.id, 'manejo_defensivo', enDias(200)).then((r) =>
        expect(r.status).toBe(201),
      );
      await permiso(CONDUCTOR.id, 'examen_medico', enDias(15)).then((r) =>
        expect(r.status).toBe(201),
      );
      await permiso(CONDUCTOR.id, 'examen_psicosensometrico', enDias(300)).then((r) =>
        expect(r.status).toBe(201),
      );
      await permiso(CONDUCTOR.id, 'documentos_clientes').then((r) => expect(r.status).toBe(201));
      // vacunas vencidas ayer: no reúne condiciones
      const vencida = await permiso(CONDUCTOR.id, 'vacunas', enDias(-1));
      expect(vencida.status).toBe(201);
      e = (await http().get(`${base}/conductores/${CONDUCTOR.id}`).set(operador()).expect(200))
        .body;
      expect(e.reuneCondiciones).toBe(false);
      expect(
        e.documentos.find((d: { tipo: { codigo: string } }) => d.tipo.codigo === 'vacunas').estado,
      ).toBe('vencido');
      // se renueva con un registro nuevo: pasa a vigente y el examen médico queda «por vencer»
      await permiso(CONDUCTOR.id, 'vacunas', enDias(365)).then((r) => expect(r.status).toBe(201));
      e = (await http().get(`${base}/conductores/${CONDUCTOR.id}`).set(operador()).expect(200))
        .body;
      expect(e.reuneCondiciones).toBe(true);
      expect(e.porVencer).toEqual(['Examen médico']);
    });

    it('anular un documento deja el anterior como vigente y no se anula dos veces', async () => {
      const h = (
        await http().get(`${base}/conductores/${CONDUCTOR.id}/permisos`).set(operador()).expect(200)
      ).body as Array<{ id: string; tipo: { codigo: string }; anulado: unknown }>;
      const nuevaVacuna = h.find((x) => x.tipo.codigo === 'vacunas' && !x.anulado)!;
      const a = await http()
        .post(`${base}/conductores/permisos/${nuevaVacuna.id}/anular`)
        .set(jefe())
        .send({ motivo: 'Se cargó el certificado equivocado' });
      expect(a.status).toBe(201);
      const otra = await http()
        .post(`${base}/conductores/permisos/${nuevaVacuna.id}/anular`)
        .set(jefe())
        .send({ motivo: 'Se cargó el certificado equivocado' });
      expect([otra.status, otra.body.code]).toEqual([409, 'permiso_ya_anulado']);
      let e = (await http().get(`${base}/conductores/${CONDUCTOR.id}`).set(operador()).expect(200))
        .body;
      expect(e.reuneCondiciones).toBe(false); // vuelve a regir la vencida
      await permiso(CONDUCTOR.id, 'vacunas', enDias(365)).then((r) => expect(r.status).toBe(201));
      e = (await http().get(`${base}/conductores/${CONDUCTOR.id}`).set(operador()).expect(200))
        .body;
      expect(e.reuneCondiciones).toBe(true);
      const lista = (
        await http().get(`${base}/conductores?q=Carlos Conductor`).set(operador()).expect(200)
      ).body as Array<{ usuario: { id: string } }>;
      expect(lista.map((x) => x.usuario.id)).toContain(CONDUCTOR.id);
    });

    it('la base rechaza lo que el servicio no debería dejar pasar', async () => {
      const lic = tipos.find((t) => t.codigo === 'licencia')!;
      const clientes = tipos.find((t) => t.codigo === 'documentos_clientes')!;
      const insertar = (tipoId: string, conVigencia: boolean, hasta: string | null) =>
        admin.query(
          `INSERT INTO flota.conductor_permiso (id, usuario_id, tipo_id, con_vigencia, vigente_hasta, created_by)
           VALUES ($1, $2, $3, $4, $5, $2)`,
          [uuidv7(), CONDUCTOR_SIN.id, tipoId, conVigencia, hasta],
        );
      // un documento que vence, sin fecha
      expect(await rechazoDeBase(insertar(lic.id, true, null))).toMatch(/vigencia_check/);
      // un documento sin vigencia, con fecha
      expect(await rechazoDeBase(insertar(clientes.id, false, enDias(3)))).toMatch(
        /vigencia_check/,
      );
      // la bandera `con_vigencia` no coincide con la del tipo (FK compuesta)
      expect(await rechazoDeBase(insertar(lic.id, false, null))).toMatch(
        /conductor_permiso_tipo_fkey/,
      );
      // historia inmutable para la aplicación
      const permisoId = (
        await admin.query('SELECT id FROM flota.conductor_permiso WHERE usuario_id = $1 LIMIT 1', [
          CONDUCTOR.id,
        ])
      ).rows[0].id;
      expect(
        await rechazoDeBase(
          appDb.query("UPDATE flota.conductor_permiso SET observaciones = 'x' WHERE id = $1", [
            permisoId,
          ]),
        ),
      ).toMatch(/permission denied/);
      expect(
        await rechazoDeBase(
          appDb.query('DELETE FROM flota.conductor_permiso WHERE id = $1', [permisoId]),
        ),
      ).toMatch(/permission denied/);
    });
  });

  describe('F3: caso de inspección desde la asignación de Pumping', () => {
    it('abre un caso por cada unidad de transporte asignada y es idempotente', async () => {
      await asignacion([
        { usuarioId: OPERADOR.id, vehiculoId: VEHICULO.id },
        { usuarioId: CONDUCTOR.id, vehiculoId: uuidv7() }, // un vehículo que no es unidad de Flota: se ignora
      ]);
      let c = await casos();
      expect(c).toHaveLength(1);
      expect(c[0]).toMatchObject({
        estado: 'pendiente',
        operador: { id: OPERADOR.id },
        unidad: { id: unidadId },
      });
      // otra asignación del mismo ticket cambia el operador; no duplica
      await asignacion([{ usuarioId: CONDUCTOR.id, vehiculoId: VEHICULO.id }]);
      c = await casos();
      expect(c).toHaveLength(1);
      expect(c[0].operador.id).toBe(CONDUCTOR.id);
      // una unidad que sale de la asignación y no tiene inspecciones se retira
      await asignacion([{ usuarioId: OPERADOR.id, vehiculoId: VEHICULO_2.id }]);
      c = await casos();
      expect(c.map((x) => x.unidad.id)).toEqual([unidad2Id]);
      await asignacion([
        { usuarioId: OPERADOR.id, vehiculoId: VEHICULO.id },
        { usuarioId: OPERADOR.id, vehiculoId: VEHICULO_2.id },
      ]);
      expect(await casos()).toHaveLength(2);
    });

    it('D2: Pumping manda la unidad de Flota: abre el caso aunque no tenga vehículo enlazado, prefiere la unidad al vehículo y ignora lo que no es transporte activo', async () => {
      const crearUnidad = async (extra: Record<string, unknown>) => {
        const r = await http()
          .post(`${base}/unidades`)
          .set(jefe())
          .send({
            codigo: `INS-D2-${String(n).slice(-6)}${unidades.length}`,
            nombre: 'Unidad de prueba D2',
            ...extra,
          })
          .expect(201);
        unidades.push(r.body.id);
        return r.body.id as string;
      };
      const sinVehiculo = await crearUnidad({
        tipo: 'transporte',
        categoriaPeso: 'liviano',
        lecturaInicial: 1000,
      });
      const deServicio = await crearUnidad({ tipo: 'servicio' });
      const unidadesDeCasos = async () => (await casos()).map((x) => x.unidad.id).sort();

      // una unidad de transporte sin vehículo del catálogo: el evento trae `vehiculoId` nulo y alcanza con la unidad
      await asignacion([{ usuarioId: OPERADOR.id, unidadId: sinVehiculo, vehiculoId: null }]);
      expect(await unidadesDeCasos()).toEqual([sinVehiculo]);
      // con la unidad y el vehículo a la vez, manda la unidad (aunque el vehículo sea de otra)
      await asignacion([{ usuarioId: OPERADOR.id, unidadId: unidad2Id, vehiculoId: VEHICULO.id }]);
      expect(await unidadesDeCasos()).toEqual([unidad2Id]);
      // una unidad de servicio o que no existe no abre caso; la de transporte del mismo evento, sí
      await asignacion([
        { usuarioId: OPERADOR.id, unidadId: deServicio, vehiculoId: null },
        { usuarioId: OPERADOR.id, unidadId: uuidv7(), vehiculoId: null },
        { usuarioId: CONDUCTOR.id, unidadId, vehiculoId: VEHICULO.id },
      ]);
      expect(await unidadesDeCasos()).toEqual([unidadId]);
      // un par sin unidad ni vehículo se ignora sin error
      await expect(asignacion([{ usuarioId: OPERADOR.id }])).resolves.toBeUndefined();
    });

    it('si la asignación trae conductor por unidad, él es el responsable del caso (no el operador)', async () => {
      const e = createEvent({
        type: 'operaciones.pumping.asignacion_realizada',
        source: 'operaciones',
        subject: { type: 'pumping_ticket', id: ticketId },
        data: {
          ticketId,
          operadoresUnidades: [{ usuarioId: OPERADOR.id, vehiculoId: VEHICULO.id }],
          conductoresUnidades: [{ usuarioId: CONDUCTOR.id, vehiculoId: VEHICULO.id }],
          asignados: [{ usuarioId: SUPERVISOR.id, rolCodigo: 'supervisor' }],
        },
        actor: { userId: SUPERVISOR.id, role: 'jefe_base' },
      });
      eventosEnviados.push(e.id);
      await app.get(AsignacionPumpingConsumer).consumir(e);
      const c = await casos();
      expect(c).toHaveLength(1);
      expect(c[0].operador.id).toBe(CONDUCTOR.id);
      // lo deja como estaba para las pruebas siguientes
      await asignacion([
        { usuarioId: OPERADOR.id, vehiculoId: VEHICULO.id },
        { usuarioId: OPERADOR.id, vehiculoId: VEHICULO_2.id },
      ]);
    });

    it('un evento de un ticket que no existe se ignora sin error', async () => {
      const e = createEvent({
        type: 'operaciones.pumping.asignacion_realizada',
        source: 'operaciones',
        subject: { type: 'pumping_ticket', id: uuidv7() },
        data: {
          ticketId: uuidv7(),
          operadoresUnidades: [{ usuarioId: OPERADOR.id, vehiculoId: VEHICULO.id }],
        },
      });
      eventosEnviados.push(e.id);
      await expect(app.get(AsignacionPumpingConsumer).consumir(e)).resolves.toBeUndefined();
    });
  });

  describe('F3: registrar, revisar y anular la inspección', () => {
    let casoA = '';
    let casoB = '';
    let inspA = '';
    const cuerpo = (extra: Record<string, unknown> = {}) => ({
      casoId: casoA,
      puntoPartida: 'Base Coca',
      destino: 'Pozo Prueba 1',
      conductorId: CONDUCTOR.id,
      km: 1200,
      resultados: todoCumple(),
      ...extra,
    });

    beforeAll(async () => {
      const c = await casos();
      casoA = c.find((x) => x.unidad.id === unidadId)!.id;
      casoB = c.find((x) => x.unidad.id === unidad2Id)!.id;
    });

    it('rechaza lo que no cumple las reglas: conductor sin documentos, formato incompleto, unidad que no es de transporte', async () => {
      const sin = await registrar(cuerpo({ conductorId: CONDUCTOR_SIN.id }));
      expect([sin.status, sin.body.code]).toEqual([422, 'conductor_sin_condiciones']);
      expect(sin.body.detail ?? sin.body.message).toMatch(/Cesar Sin Documentos/);
      const corto = await registrar(cuerpo({ resultados: todoCumple().slice(1) }));
      expect([corto.status, corto.body.code]).toEqual([400, 'checklist_incompleto']);
      const repetido = await registrar(cuerpo({ resultados: [...todoCumple(), todoCumple()[0]] }));
      expect(repetido.status).toBe(400);
      const servicio = await http()
        .post(`${base}/unidades`)
        .set(jefe())
        .send({
          codigo: `INS-SV-${String(n).slice(-6)}`,
          nombre: 'Bomba de prueba',
          tipo: 'servicio',
        })
        .expect(201);
      unidades.push(servicio.body.id);
      const noTransporte = await registrar({
        unidadId: servicio.body.id,
        puntoPartida: 'Base',
        conductorId: CONDUCTOR.id,
        km: 10,
        resultados: todoCumple(),
      });
      expect([noTransporte.status, noTransporte.body.code]).toEqual([
        409,
        'unidad_no_es_transporte',
      ]);
      // ninguna de las pruebas anteriores dejó una inspección
      const hay = await admin.query(
        'SELECT count(*)::int AS n FROM flota.inspeccion_vehiculo WHERE unidad_id = $1',
        [unidadId],
      );
      expect(hay.rows[0].n).toBe(0);
    });

    it('registra la inspección: queda por aprobar, alimenta el odómetro y publica los eventos del contrato', async () => {
      const bajo = await registrar(cuerpo({ km: 900 }));
      expect([bajo.status, bajo.body.code]).toEqual([409, 'lectura_menor_que_la_anterior']);
      const r = await registrar(cuerpo());
      expect(r.status).toBe(201);
      inspA = r.body.id;
      expect(r.body).toMatchObject({ hayNovedades: false, bloqueaUso: false, momento: 'salida' });
      expect((await casos()).find((x) => x.id === casoA)!.estado).toBe('por_aprobar');

      const lectura = await admin.query(
        'SELECT tipo, valor::float AS valor, fuente FROM flota.unidad_lectura WHERE inspeccion_id = $1',
        [inspA],
      );
      expect(lectura.rows).toEqual([{ tipo: 'odometro', valor: 1200, fuente: 'inspeccion' }]);
      const d = (
        await http().get(`${base}/inspecciones-vehiculo/${inspA}`).set(operador()).expect(200)
      ).body;
      expect(d).toMatchObject({ km: 1200, estado: 'por_aprobar', conductor: { id: CONDUCTOR.id } });
      expect(d.resultados).toHaveLength(30);
      expect(d.unidad.vehiculo.placa).toBe(VEHICULO.placa); // la placa sale del catálogo, no se copia

      const realizada = await eventos('flota.inspeccion_vehiculo.realizada', inspA);
      expect(realizada).toHaveLength(1);
      expect(realizada[0]).toMatchObject({ ticketId, vehiculoId: VEHICULO.id, unidadId });
      const fuente = await admin.query(
        "SELECT datos->>'source' AS source FROM msg_operaciones.outbox WHERE tipo = 'flota.inspeccion_vehiculo.realizada' AND datos->'data'->>'inspeccionId' = $1",
        [inspA],
      );
      expect(fuente.rows[0].source).toBe('flota');

      const otra = await registrar(cuerpo());
      expect([otra.status, otra.body.code]).toEqual([409, 'inspeccion_ya_registrada']);
    });

    it('el Supervisor aprueba (una vez); el evento lleva ticket y vehículo del catálogo', async () => {
      await http()
        .post(`${base}/inspecciones-vehiculo/${inspA}/aprobar`)
        .set(supervisor())
        .expect(201);
      expect((await casos()).find((x) => x.id === casoA)!.estado).toBe('aprobada');
      const ev = await eventos('flota.inspeccion_vehiculo.aprobada', inspA);
      expect(ev[0]).toMatchObject({ ticketId, vehiculoId: VEHICULO.id, unidadId });
      const otra = await http()
        .post(`${base}/inspecciones-vehiculo/${inspA}/aprobar`)
        .set(supervisor());
      expect([otra.status, otra.body.code]).toEqual([409, 'inspeccion_ya_aprobada']);
      const anular = await http()
        .post(`${base}/inspecciones-vehiculo/${inspA}/anular`)
        .set(jefe())
        .send({ motivo: 'Quiero repetirla' });
      expect([anular.status, anular.body.code]).toEqual([409, 'inspeccion_aprobada']);
    });

    it('D13: solo el supervisor asignado al ticket aprueba o rechaza; otro supervisor con el permiso recibe 403', async () => {
      const r = await registrar(cuerpo({ casoId: casoB, resultados: todoCumple() }));
      expect(r.status).toBe(201);
      const insp = r.body.id as string;
      const otro = token('supervisor_pumping', 'Otro Supervisor', PERMISOS_SUPERVISOR, uuidv7());
      for (const accion of ['aprobar', 'rechazar']) {
        const x = await http()
          .post(`${base}/inspecciones-vehiculo/${insp}/${accion}`)
          .set(otro)
          .send({ motivo: 'No me corresponde' });
        expect([x.status, x.body.code]).toEqual([403, 'solo_supervisor_asignado']);
      }
      // el caso guarda al supervisor que trajo el evento de asignación
      const fila = await admin.query(
        'SELECT supervisor_id FROM flota.inspeccion_caso WHERE id = $1',
        [casoB],
      );
      expect(fila.rows[0].supervisor_id).toBe(SUPERVISOR.id);
      // lo deja anulado para no alterar las pruebas siguientes
      await http()
        .post(`${base}/inspecciones-vehiculo/${insp}/anular`)
        .set(jefe())
        .send({ motivo: 'Prueba de la regla del supervisor asignado' })
        .expect(201);
    });

    it('Nota 1: con el cinturón en «No cumple» se registra pero no se aprueba (también lo impide la base)', async () => {
      const r = await registrar(cuerpo({ casoId: casoB, resultados: conCinturon('no_cumple') }));
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ hayNovedades: true, bloqueaUso: true });
      const insp = r.body.id as string;
      const ap = await http()
        .post(`${base}/inspecciones-vehiculo/${insp}/aprobar`)
        .set(supervisor());
      expect([ap.status, ap.body.code]).toEqual([409, 'nota_1_bloquea_uso']);
      // el servicio no es la única barrera: el INSERT directo también falla
      const msg = await rechazoDeBase(
        admin.query(
          "INSERT INTO flota.inspeccion_vehiculo_revision (id, inspeccion_id, decision, revisada_por) VALUES ($1, $2, 'aprobada', $3)",
          [uuidv7(), insp, SUPERVISOR.id],
        ),
      );
      expect(msg).toMatch(/Nota 1/);
      // el Supervisor la rechaza: queda anulada y se publican los dos hechos (rechazada y anulada)
      const sinMotivo = await http()
        .post(`${base}/inspecciones-vehiculo/${insp}/rechazar`)
        .set(supervisor())
        .send({ motivo: 'no' });
      expect(sinMotivo.status).toBe(400);
      await http()
        .post(`${base}/inspecciones-vehiculo/${insp}/rechazar`)
        .set(supervisor())
        .send({ motivo: 'Cinturón dañado, no puede salir' })
        .expect(201);
      expect(await eventos('flota.inspeccion_vehiculo.rechazada', insp)).toHaveLength(1);
      expect(await eventos('flota.inspeccion_vehiculo.anulada', insp)).toHaveLength(1);
      const d = (
        await http().get(`${base}/inspecciones-vehiculo/${insp}`).set(operador()).expect(200)
      ).body;
      expect(d.estado).toBe('anulada');
      expect(d.anulada.motivo).toMatch(/Cinturón dañado/);
      expect((await casos()).find((x) => x.id === casoB)!.estado).toBe('pendiente');
      // no se revisa una inspección anulada y el caso admite repetir la inspección
      await http()
        .post(`${base}/inspecciones-vehiculo/${insp}/aprobar`)
        .set(supervisor())
        .expect(409);
      const repetida = await registrar(
        cuerpo({ casoId: casoB, km: 1300, resultados: conCinturon('cumple') }),
      );
      expect(repetida.status).toBe(201);
    });

    it('la inspección de llegada es otra inspección: no repite el evento de salida y exige el odómetro', async () => {
      const bajo = await registrar(cuerpo({ momento: 'llegada', km: 1100 }));
      expect(bajo.status).toBe(409);
      const r = await registrar(
        cuerpo({
          momento: 'llegada',
          km: 1350,
          puntoPartida: 'Pozo Prueba 1',
          destino: 'Base Coca',
        }),
      );
      expect(r.status).toBe(201);
      expect(await eventos('flota.inspeccion_vehiculo.realizada', r.body.id)).toHaveLength(0);
      expect(await eventos('flota.inspeccion_vehiculo.registrada', r.body.id)).toHaveLength(1);
      const c = (await casos()).find((x) => x.id === casoA)!;
      expect(c.llegadaInspeccionId).toBe(r.body.id);
      const unica = await registrar(cuerpo({ momento: 'llegada', km: 1360 }));
      expect(unica.status).toBe(409);
    });

    it('anular una inspección sin aprobar la saca de la lista y reabre el requisito', async () => {
      const insp = (
        await http()
          .get(`${base}/inspecciones-vehiculo?ticketId=${ticketId}&momento=salida`)
          .set(operador())
          .expect(200)
      ).body as Array<{ id: string; unidad: { id: string } }>;
      const deB = insp.find((x) => x.unidad.id === unidad2Id)!;
      await http()
        .post(`${base}/inspecciones-vehiculo/${deB.id}/anular`)
        .set(operador())
        .send({ motivo: 'Error de registro' })
        .expect(403);
      await http()
        .post(`${base}/inspecciones-vehiculo/${deB.id}/anular`)
        .set(jefe())
        .send({ motivo: 'Error de registro del kilometraje' })
        .expect(201);
      expect(await eventos('flota.inspeccion_vehiculo.anulada', deB.id)).toHaveLength(1);
      const lista = (
        await http()
          .get(`${base}/inspecciones-vehiculo?ticketId=${ticketId}&momento=salida`)
          .set(operador())
          .expect(200)
      ).body as Array<{ id: string }>;
      expect(lista.map((x) => x.id)).not.toContain(deB.id);
    });
  });

  describe('F3: reglas que garantiza la base', () => {
    it('la inspección no se edita ni se borra; solo se marca la anulación, una vez', async () => {
      const insp = (
        await admin.query(
          'SELECT id FROM flota.inspeccion_vehiculo WHERE unidad_id = $1 AND anulada_at IS NULL LIMIT 1',
          [unidadId],
        )
      ).rows[0].id;
      expect(
        await rechazoDeBase(
          appDb.query("UPDATE flota.inspeccion_vehiculo SET punto_partida = 'otro' WHERE id = $1", [
            insp,
          ]),
        ),
      ).toMatch(/permission denied/);
      expect(
        await rechazoDeBase(
          appDb.query('DELETE FROM flota.inspeccion_vehiculo WHERE id = $1', [insp]),
        ),
      ).toMatch(/permission denied/);
      expect(
        await rechazoDeBase(
          appDb.query(
            "UPDATE flota.inspeccion_vehiculo_resultado SET resultado = 'cumple' WHERE inspeccion_id = $1",
            [insp],
          ),
        ),
      ).toMatch(/permission denied/);
      expect(
        await rechazoDeBase(
          appDb.query('DELETE FROM flota.inspeccion_vehiculo_revision WHERE inspeccion_id = $1', [
            insp,
          ]),
        ),
      ).toMatch(/permission denied/);
      const anulada = (
        await admin.query(
          'SELECT id FROM flota.inspeccion_vehiculo WHERE unidad_id = $1 AND anulada_at IS NOT NULL LIMIT 1',
          [unidad2Id],
        )
      ).rows[0].id;
      expect(
        await rechazoDeBase(
          appDb.query(
            "UPDATE flota.inspeccion_vehiculo SET anulada_at = now(), anulada_por = $2, anulacion_motivo = 'Otro motivo distinto' WHERE id = $1",
            [anulada, JEFE.id],
          ),
        ),
      ).toMatch(/ya está anulada/);
    });

    it('la anulación exige quién y un motivo de al menos 5 letras', async () => {
      const insp = (
        await admin.query(
          'SELECT id FROM flota.inspeccion_vehiculo WHERE unidad_id = $1 AND anulada_at IS NULL LIMIT 1',
          [unidadId],
        )
      ).rows[0].id;
      expect(
        await rechazoDeBase(
          appDb.query(
            "UPDATE flota.inspeccion_vehiculo SET anulada_at = now(), anulada_por = $2, anulacion_motivo = 'no' WHERE id = $1",
            [insp, JEFE.id],
          ),
        ),
      ).toMatch(/anulacion_check/);
      expect(
        await rechazoDeBase(
          appDb.query('UPDATE flota.inspeccion_vehiculo SET anulada_at = now() WHERE id = $1', [
            insp,
          ]),
        ),
      ).toMatch(/anulacion_check/);
    });

    it('el caso y la inspección deben ser de la misma unidad; una sola vigente por caso y momento', async () => {
      const caso = (
        await admin.query(
          'SELECT id FROM flota.inspeccion_caso WHERE ticket_id = $1 AND unidad_id = $2',
          [ticketId, unidadId],
        )
      ).rows[0].id;
      // `anulada` evita el índice único parcial para que el rechazo sea el de la FK compuesta
      const insertar = (unidad: string, momento: string, anulada: boolean) =>
        admin.query(
          `INSERT INTO flota.inspeccion_vehiculo (id, caso_id, unidad_id, momento, fecha, punto_partida, conductor_id, created_by,
                                                  anulada_at, anulada_por, anulacion_motivo)
           VALUES ($1, $2, $3, $4, now(), 'Base', $5, $5, ${anulada ? "now(), $5, 'Prueba de la FK'" : 'NULL, NULL, NULL'})`,
          [uuidv7(), caso, unidad, momento, CONDUCTOR.id],
        );
      expect(await rechazoDeBase(insertar(unidad2Id, 'salida', true))).toMatch(
        /inspeccion_vehiculo_caso_fkey/,
      );
      expect(await rechazoDeBase(insertar(unidadId, 'salida', false))).toMatch(
        /caso_momento_vigente_key/,
      );
    });

    it('la lectura de origen «inspección» exige su inspección, y solo ella la lleva', async () => {
      const insp = (
        await admin.query(
          'SELECT id FROM flota.inspeccion_vehiculo WHERE unidad_id = $1 AND anulada_at IS NULL LIMIT 1',
          [unidadId],
        )
      ).rows[0].id;
      const insertar = (fuente: string, inspeccionId: string | null) =>
        admin.query(
          `INSERT INTO flota.unidad_lectura (id, unidad_id, tipo, valor, leida_at, fuente, inspeccion_id)
           VALUES ($1, $2, 'odometro', 9999, now(), $3::flota.fuente_lectura, $4)`,
          [uuidv7(), unidadId, fuente, inspeccionId],
        );
      expect(await rechazoDeBase(insertar('inspeccion', null))).toMatch(/origen_check/);
      expect(await rechazoDeBase(insertar('manual', insp))).toMatch(/origen_check/);
      expect(await rechazoDeBase(insertar('inspeccion', insp))).toMatch(
        /inspeccion_id_key|unique/i,
      );
    });
  });
});
