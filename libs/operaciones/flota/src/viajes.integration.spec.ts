/**
 * Integración real de Flota (tramo F4): Gerenciamiento de Viaje (DYN-SGI-RE-049). Cuestionario con puntaje, nivel de riesgo por umbrales,
 * quién autoriza cada nivel, eventos del contrato 3 y las reglas que garantiza la base. Limpia lo que crea.
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
import { MessagingModule } from '@dyn/messaging';
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
const hoy = new Date().toISOString().slice(0, 10);

const JEFE = { id: uuidv7(), nombre: 'Mario Jefe Mantenimiento' };
const CONDUCTOR = { id: uuidv7(), nombre: 'Carlos Conductor Viaje' };
const CONDUCTOR_2 = { id: uuidv7(), nombre: 'Camila Conductora Viaje' };
const SUPERVISOR = { id: uuidv7(), nombre: 'Sara Supervisora Viaje' };
const GERENTE = { id: uuidv7(), nombre: 'Gabriel Gerente HSE' };
const VEHICULO = { id: uuidv7(), placa: `VJ${String(n).slice(-5)}A` };
const MAESTROS: MaestrosDePrueba = {
  usuarios: [
    { id: JEFE.id, nombre: JEFE.nombre, rol: 'jefe_mantenimiento' },
    { id: CONDUCTOR.id, nombre: CONDUCTOR.nombre, rol: 'conductor' },
    { id: CONDUCTOR_2.id, nombre: CONDUCTOR_2.nombre, rol: 'conductor' },
    { id: SUPERVISOR.id, nombre: SUPERVISOR.nombre, rol: 'supervisor_pumping' },
    { id: GERENTE.id, nombre: GERENTE.nombre, rol: 'gerente_hse' },
  ],
  vehiculos: [VEHICULO],
};

run('Flota F4: gerenciamiento de viaje (base de datos real)', () => {
  jest.setTimeout(180000);
  let app: INestApplication;
  const admin = new Pool({ connectionString: MIGRATOR_DB, max: 2 });
  const appDb = new Pool({ connectionString: APP_DB.replace('?pgbouncer=true', ''), max: 2 });
  const http = () => request(app.getHttpServer());
  const signer = new JwtService({
    privateKey,
    signOptions: { algorithm: 'RS256', issuer: 'dynadrill-plataforma', expiresIn: 600 },
  });
  const token = (roleCode: string, name: string, permissions: string[], sub: string) => ({
    Authorization: `Bearer ${signer.sign({ sub, email: `${roleCode}@test.local`, name, roleId: 'r', roleCode, permissions })}`,
  });
  const jefe = () =>
    token('jefe_mantenimiento', JEFE.nombre, [P.UNIDADES_VER, P.UNIDADES_CREAR], JEFE.id);
  const conductor = () => token('conductor', CONDUCTOR.nombre, [P.VIAJES_SOLICITAR], CONDUCTOR.id);
  const conductor2 = () =>
    token('conductor', CONDUCTOR_2.nombre, [P.VIAJES_SOLICITAR], CONDUCTOR_2.id);
  const supervisor = () =>
    token('supervisor_pumping', SUPERVISOR.nombre, [P.VIAJES_APROBAR], SUPERVISOR.id);
  const gerente = () =>
    token('gerente_hse', GERENTE.nombre, [P.VIAJES_APROBAR, P.VIAJES_AUTORIZAR_MAYOR], GERENTE.id);
  /** Quien solicita y además tiene el permiso de autorizar (como el Jefe de Base). */
  const jefeBase = (id: string) =>
    token(
      'jefe_base',
      'Jose Jefe de Base',
      [P.VIAJES_SOLICITAR, P.VIAJES_APROBAR, P.VIAJES_AUTORIZAR_MAYOR],
      id,
    );

  const base = '/api/operaciones/flota/gerenciamientos-viaje';
  const tickets = [uuidv7(), uuidv7(), uuidv7(), uuidv7()];
  const unidades: string[] = [];
  let unidadId = '';
  let servicioId = '';
  let bodegaId = '';
  let pozoId = '';
  type Pregunta = {
    id: string;
    codigo: string;
    opciones: Array<{ id: string; puntos: number; impideConducir: boolean }>;
  };
  let preguntas: Pregunta[] = [];
  /** Puntos de la respuesta más baja de cada pregunta (el formato no parte de cero). */
  let base0 = 0;

  /** Una respuesta por pregunta: la de menos puntos que permite viajar, salvo las que se piden como las de más puntos. */
  const respuestas = (altas: string[] = []) =>
    preguntas.map((p) => {
      const validas = p.opciones.filter((o) => !o.impideConducir);
      const elegida = altas.includes(p.codigo)
        ? validas.reduce((a, b) => (b.puntos > a.puntos ? b : a))
        : validas.reduce((a, b) => (b.puntos < a.puntos ? b : a));
      return { preguntaId: p.id, opcionId: elegida.id };
    });
  const cuerpo = (extra: Record<string, unknown> = {}) => ({
    tipo: 'salida',
    ticketId: tickets[0],
    unidadId,
    fecha: hoy,
    motivo: 'Traslado de equipo al pozo',
    origen: { bodegaId },
    destino: { pozoId },
    respuestas: respuestas(),
    horaSalida: '06:00',
    horaLlegada: '10:30',
    paradas: [{ lugar: 'Peaje Pifo', horaLlegada: '07:00', horaSalida: '07:10' }],
    comunicaciones: [
      { frecuencia: 'Cada 2 horas', personaContacto: 'Base Coca', datosContacto: '0990000000' },
    ],
    ...extra,
  });
  const solicitar = (c: Record<string, unknown>, quien = conductor()) =>
    http().post(base).set(quien).send(c);
  const eventos = async (tipo: string, id: string) =>
    (
      await admin.query(
        "SELECT datos->'data' AS data FROM msg_operaciones.outbox WHERE tipo = $1 AND datos->'data'->>'gerenciamientoId' = $2",
        [tipo, id],
      )
    ).rows.map((r: { data: Record<string, unknown> }) => r.data);
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
    jest.spyOn(AsignacionPumpingConsumer.prototype, 'onApplicationBootstrap').mockResolvedValue();
    await sembrarMaestros(admin, MAESTROS);
    for (const t of tickets) {
      await admin.query(
        "INSERT INTO pumping.ticket (id, pedido_id, pedido_codigo, paso_codigo) VALUES ($1, $2, $3, 'revision_inicial')",
        [t, uuidv7(), `PED-VJ-${n}-${t.slice(-4)}`],
      );
    }
    bodegaId = (await admin.query("SELECT id FROM catalogos.bodega WHERE nombre = 'Bodega Matriz'"))
      .rows[0].id;
    pozoId = (await admin.query('SELECT id FROM catalogos.pozo LIMIT 1')).rows[0].id;
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
        FlotaModule,
      ],
    })
    class TestAppModule {}
    const mod = await Test.createTestingModule({ imports: [TestAppModule] }).compile();
    app = mod.createNestApplication();
    configureApp(app, { corsOrigins: ['http://localhost:4200'] });
    await app.init();

    for (const [vehiculoId, codigo, tipo] of [
      [VEHICULO.id, 'A', 'transporte'],
      [undefined, 'S', 'servicio'],
    ] as const) {
      const r = await http()
        .post('/api/operaciones/flota/unidades')
        .set(jefe())
        .send({
          codigo: `VJ-${String(n).slice(-6)}${codigo}`,
          nombre: `Unidad de prueba ${codigo}`,
          tipo,
          ...(tipo === 'transporte'
            ? { categoriaPeso: 'liviano', vehiculoId, lecturaInicial: 1000 }
            : {}),
        })
        .expect(201);
      unidades.push(r.body.id);
    }
    [unidadId, servicioId] = unidades;
    // Pumping asignó a CONDUCTOR como conductor de la unidad en cada ticket (Flota abre así el caso de inspección): solo él la solicita
    for (const t of tickets) {
      await admin.query(
        'INSERT INTO flota.inspeccion_caso (id, ticket_id, unidad_id, operador_id) VALUES ($1, $2, $3, $4)',
        [uuidv7(), t, unidadId, CONDUCTOR.id],
      );
    }
    preguntas = (await http().get(`${base}/preguntas`).set(conductor()).expect(200)).body;
  });

  afterAll(async () => {
    const q = (sql: string, p: unknown[]) => admin.query(sql, p).catch(() => undefined);
    const ids = `(SELECT id FROM flota.gerenciamiento_viaje WHERE conductor_id = ANY($1::uuid[]))`;
    const conductores = [CONDUCTOR.id, CONDUCTOR_2.id, JEFE.id];
    for (const tabla of ['respuesta', 'parada', 'comunicacion']) {
      await q(`DELETE FROM flota.gerenciamiento_viaje_${tabla} WHERE gerenciamiento_id IN ${ids}`, [
        conductores,
      ]);
    }
    await q(
      "DELETE FROM msg_operaciones.outbox WHERE datos->'data'->>'ticketId' = ANY($1::text[])",
      [tickets],
    );
    await q('DELETE FROM flota.gerenciamiento_viaje WHERE conductor_id = ANY($1::uuid[])', [
      conductores,
    ]);
    await q('DELETE FROM flota.inspeccion_caso WHERE ticket_id = ANY($1::uuid[])', [tickets]);
    await q('DELETE FROM flota.unidad_lectura WHERE unidad_id = ANY($1::uuid[])', [unidades]);
    await q(
      "DELETE FROM msg_operaciones.outbox WHERE datos->'data'->>'unidadId' = ANY($1::text[])",
      [unidades],
    );
    await q('DELETE FROM flota.unidad WHERE id = ANY($1::uuid[])', [unidades]);
    await q('DELETE FROM pumping.ticket WHERE id = ANY($1::uuid[])', [tickets]);
    await quitarMaestros(admin, MAESTROS);
    await admin.end();
    await appDb.end();
    await app.close();
  });

  describe('catálogos y permisos', () => {
    it('trae las 12 preguntas, los 3 umbrales y la base; solo quien tiene permiso del módulo entra', async () => {
      expect(preguntas).toHaveLength(12);
      const u = (await http().get(`${base}/umbrales`).set(supervisor()).expect(200)).body;
      expect(
        u.map((x: { nivel: string; desdePuntos: number }) => [x.nivel, x.desdePuntos]),
      ).toEqual([
        ['bajo', 0],
        ['medio', 31],
        ['alto', 76],
      ]);
      const impiden = await admin.query(
        'SELECT count(*)::int AS n FROM flota.opcion_riesgo_viaje WHERE impide_conducir',
      );
      expect(impiden.rows[0].n).toBe(3);
      await http().get(`${base}/preguntas`).expect(401);
      await http()
        .get(`${base}/preguntas`)
        .set(token('ingenieria_ventas', 'Vera', [], uuidv7()))
        .expect(403);
      await http().get(`${base}/bodegas`).set(conductor()).expect(200);
      // el Conductor elige la unidad de su viaje sin tener el permiso de ver unidades
      const us = (await http().get(`${base}/unidades`).set(conductor()).expect(200)).body as Array<{
        id: string;
        placa: string | null;
      }>;
      expect(us.find((x) => x.id === unidadId)?.placa).toBe(VEHICULO.placa);
      expect(us.map((x) => x.id)).not.toContain(servicioId);
      await http().get(`${base}/unidades`).set(supervisor()).expect(403);
    });

    it('el Supervisor no solicita; el Conductor no autoriza', async () => {
      await solicitar(cuerpo(), supervisor()).then((r) => expect(r.status).toBe(403));
      await http().post(`${base}/${uuidv7()}/autorizar`).set(conductor()).expect(403);
    });
  });

  describe('solicitar', () => {
    it('rechaza lo que no cumple las reglas del formato', async () => {
      const incompleto = await solicitar(cuerpo({ respuestas: respuestas().slice(1) }));
      expect([incompleto.status, incompleto.body.code]).toEqual([400, 'cuestionario_incompleto']);

      const ajena = respuestas();
      ajena[0] = { preguntaId: ajena[0].preguntaId, opcionId: preguntas[1].opciones[0].id };
      expect((await solicitar(cuerpo({ respuestas: ajena }))).status).toBe(400);

      const detenerse = respuestas();
      const p0 = preguntas[0];
      detenerse[0] = { preguntaId: p0.id, opcionId: p0.opciones.find((o) => o.impideConducir)!.id };
      const r999 = await solicitar(cuerpo({ respuestas: detenerse }));
      expect([r999.status, r999.body.code]).toEqual([422, 'conductor_no_debe_conducir']);

      const doble = await solicitar(cuerpo({ origen: { bodegaId, pozoId } }));
      expect(doble.status).toBe(400);
      const servicio = await solicitar(cuerpo({ unidadId: servicioId }));
      expect([servicio.status, servicio.body.code]).toEqual([409, 'unidad_no_es_transporte']);
      const hay = await admin.query(
        'SELECT count(*)::int AS n FROM flota.gerenciamiento_viaje WHERE conductor_id = $1',
        [CONDUCTOR.id],
      );
      expect(hay.rows[0].n).toBe(0);
    });

    it('calcula el puntaje y el nivel en el servidor y deja un solo vigente por ticket y tipo', async () => {
      const r = await solicitar(cuerpo());
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ nivel: 'bajo', estado: 'pendiente' });
      base0 = r.body.puntajeTotal;
      expect(base0).toBeLessThanOrEqual(30);
      expect(r.body.codigo).toMatch(/^GV-\d{4,}$/);
      const ev = await eventos('flota.gerenciamiento_viaje.solicitado', r.body.id);
      expect(ev[0]).toMatchObject({ ticketId: tickets[0], tipo: 'salida', nivel: 'bajo' });
      // el aviso va al Supervisor (el nivel bajo lo autoriza con `flota.viajes.aprobar`), con los textos ya resueltos
      const aviso = await eventos('flota.gerenciamiento_viaje.por_autorizar_supervisor', r.body.id);
      expect(aviso[0]).toMatchObject({
        nivelTexto: 'BAJO',
        tipoTexto: 'de salida',
        conductor: CONDUCTOR.nombre,
      });
      expect(
        await eventos('flota.gerenciamiento_viaje.por_autorizar_gerente', r.body.id),
      ).toHaveLength(0);

      const otra = await solicitar(cuerpo());
      expect([otra.status, otra.body.code]).toEqual([409, 'viaje_ya_solicitado']);
      // el retorno es otro gerenciamiento del mismo ticket
      const retorno = await solicitar(
        cuerpo({ tipo: 'retorno', origen: { pozoId }, destino: { bodegaId } }),
      );
      expect(retorno.status).toBe(201);

      const d = (await http().get(`${base}/${r.body.id}`).set(conductor()).expect(200)).body;
      expect(d).toMatchObject({ tipo: 'salida', estado: 'pendiente', nivel: 'bajo' });
      expect(d.respuestas).toHaveLength(12);
      expect(d.origen).toMatchObject({ tipo: 'bodega', nombre: 'Bodega Matriz' });
      expect(d.destino.tipo).toBe('pozo');
      expect(d.unidad.placa).toBe(VEHICULO.placa);
      expect(d.paradas).toEqual([
        { lugar: 'Peaje Pifo', horaLlegada: '07:00', horaSalida: '07:10', detallePernocta: null },
      ]);
      expect(d.horaSalida).toBe('06:00');
    });

    it('el puntaje total y los umbrales deciden el nivel: 31 o más es MEDIO y más de 75 es ALTO', async () => {
      const medio = await solicitar(
        cuerpo({ ticketId: tickets[1], respuestas: respuestas(['conductor_nuevo']) }),
      );
      expect(medio.status).toBe(201);
      // «conductor nuevo» de 0 a 3 meses suma 40 en lugar de su mínimo (0)
      expect(medio.body).toMatchObject({ nivel: 'medio', puntajeTotal: base0 + 40 });
      const alto = await solicitar(
        cuerpo({
          ticketId: tickets[2],
          respuestas: respuestas(['conductor_nuevo', 'oscuridad', 'clima']),
        }),
      );
      expect(alto.body).toMatchObject({ nivel: 'alto' });
      expect(alto.body.puntajeTotal).toBeGreaterThan(75);
      // el ALTO se avisa a los gerentes, no al Supervisor
      expect(
        await eventos('flota.gerenciamiento_viaje.por_autorizar_gerente', alto.body.id),
      ).toHaveLength(1);
      expect(
        await eventos('flota.gerenciamiento_viaje.por_autorizar_supervisor', alto.body.id),
      ).toHaveLength(0);
    });
  });

  describe('autorizar y rechazar', () => {
    const porTicket = async (ticketId: string, tipo = 'salida') =>
      (await http().get(`${base}?ticketId=${ticketId}&tipo=${tipo}`).set(gerente()).expect(200))
        .body[0] as { id: string; estado: string; puedeDecidir: boolean };

    it('BAJO lo autoriza el Supervisor: se publica «aprobado» con ticket y tipo, una sola vez', async () => {
      const v = await porTicket(tickets[0]);
      expect(v.puedeDecidir).toBe(true);
      await http().post(`${base}/${v.id}/autorizar`).set(supervisor()).expect(201);
      const ev = await eventos('flota.gerenciamiento_viaje.aprobado', v.id);
      expect(ev).toHaveLength(1);
      expect(ev[0]).toMatchObject({ ticketId: tickets[0], tipo: 'salida' });
      const fuente = await admin.query(
        "SELECT datos->>'source' AS source FROM msg_operaciones.outbox WHERE tipo = 'flota.gerenciamiento_viaje.aprobado' AND datos->'data'->>'gerenciamientoId' = $1",
        [v.id],
      );
      expect(fuente.rows[0].source).toBe('flota');
      // la decisión se avisa a la cuenta del Conductor
      const decidido = await eventos('flota.gerenciamiento_viaje.decidido', v.id);
      expect(decidido[0]).toMatchObject({
        resultado: 'autorizado',
        asignados: [{ usuarioId: CONDUCTOR.id, rolCodigo: 'conductor' }],
      });
      const otra = await http().post(`${base}/${v.id}/autorizar`).set(supervisor());
      expect([otra.status, otra.body.code]).toEqual([409, 'viaje_ya_decidido']);
    });

    it('MEDIO lo autoriza el Supervisor; ALTO solo un gerente', async () => {
      const medio = await porTicket(tickets[1]);
      const sup = (await http().get(`${base}?ticketId=${tickets[1]}`).set(supervisor()).expect(200))
        .body[0];
      expect(sup.puedeDecidir).toBe(true);
      await http().post(`${base}/${medio.id}/autorizar`).set(supervisor()).expect(201);
      // el ALTO (ticket 3): el Supervisor no puede, el gerente sí
      const alto = await porTicket(tickets[2]);
      expect(alto.puedeDecidir).toBe(true);
      const supAlto = (
        await http().get(`${base}?ticketId=${tickets[2]}`).set(supervisor()).expect(200)
      ).body[0];
      expect(supAlto.puedeDecidir).toBe(false);
      const r = await http().post(`${base}/${alto.id}/autorizar`).set(supervisor());
      expect([r.status, r.body.code]).toEqual([403, 'nivel_requiere_otro_rol']);
      expect(r.body.detail ?? r.body.message).toMatch(/gerente/);
    });

    it('un gerente con solo el permiso mayor también autoriza los niveles bajos', async () => {
      const soloGerente = token(
        'gerente_hse',
        GERENTE.nombre,
        [P.VIAJES_AUTORIZAR_MAYOR],
        GERENTE.id,
      );
      const nuevo = await solicitar(cuerpo({ ticketId: null, tipo: 'salida' }), conductor2());
      expect(nuevo.status).toBe(201);
      await http().post(`${base}/${nuevo.body.id}/autorizar`).set(soloGerente).expect(201);
    });

    it('rechazar exige motivo, publica «rechazado» y deja rehacer la solicitud', async () => {
      const alto = await porTicket(tickets[2]);
      const corto = await http()
        .post(`${base}/${alto.id}/rechazar`)
        .set(gerente())
        .send({ motivo: 'no' });
      expect(corto.status).toBe(400);
      await http()
        .post(`${base}/${alto.id}/rechazar`)
        .set(gerente())
        .send({ motivo: 'Riesgo ALTO sin escolta' })
        .expect(201);
      const ev = await eventos('flota.gerenciamiento_viaje.rechazado', alto.id);
      expect(ev[0]).toMatchObject({
        ticketId: tickets[2],
        tipo: 'salida',
        motivo: 'Riesgo ALTO sin escolta',
      });
      expect(
        (await http().get(`${base}/${alto.id}`).set(conductor()).expect(200)).body,
      ).toMatchObject({
        estado: 'rechazado',
        decision: { motivo: 'Riesgo ALTO sin escolta' },
      });
      const rehecho = await solicitar(cuerpo({ ticketId: tickets[2] }));
      expect(rehecho.status).toBe(201);
    });

    it('nadie decide sobre su propia solicitud', async () => {
      // la cuenta del token debe existir (FK): el «Jefe de Base» de la prueba usa la cuenta sembrada del Jefe de Mantenimiento
      const mio = await solicitar(cuerpo({ ticketId: tickets[3] }), jefeBase(JEFE.id));
      expect(mio.status).toBe(201);
      const r = await http().post(`${base}/${mio.body.id}/autorizar`).set(jefeBase(JEFE.id));
      expect([r.status, r.body.code]).toEqual([403, 'viaje_propio']);
    });

    it('el Conductor ve solo lo suyo; quien autoriza ve todo', async () => {
      const otro = await solicitar(cuerpo({ ticketId: null, tipo: 'salida' }), conductor2());
      expect(otro.status).toBe(201);
      const mias = (await http().get(base).set(conductor()).expect(200)).body as Array<{
        conductor: { id: string };
      }>;
      expect(mias.length).toBeGreaterThan(0);
      expect(mias.every((x) => x.conductor.id === CONDUCTOR.id)).toBe(true);
      await http().get(`${base}/${otro.body.id}`).set(conductor()).expect(404);
      const todas = (await http().get(`${base}?estado=pendiente`).set(supervisor()).expect(200))
        .body as Array<{ id: string }>;
      expect(todas.map((x) => x.id)).toContain(otro.body.id);
    });
  });

  describe('reglas que garantiza la base', () => {
    let viaje = '';
    beforeAll(async () => {
      viaje = (
        await admin.query(
          'SELECT id FROM flota.gerenciamiento_viaje WHERE conductor_id = $1 AND decision IS NULL LIMIT 1',
          [CONDUCTOR_2.id],
        )
      ).rows[0].id;
    });

    it('el documento no se edita ni se borra; solo se marca la decisión, una vez', async () => {
      expect(
        await rechazoDeBase(
          appDb.query('UPDATE flota.gerenciamiento_viaje SET puntaje_total = 0 WHERE id = $1', [
            viaje,
          ]),
        ),
      ).toMatch(/permission denied/);
      expect(
        await rechazoDeBase(
          appDb.query('DELETE FROM flota.gerenciamiento_viaje WHERE id = $1', [viaje]),
        ),
      ).toMatch(/permission denied/);
      for (const sql of [
        'UPDATE flota.gerenciamiento_viaje_respuesta SET opcion_id = opcion_id',
        'DELETE FROM flota.gerenciamiento_viaje_respuesta',
        'UPDATE flota.gerenciamiento_viaje_parada SET lugar = lugar',
        'DELETE FROM flota.gerenciamiento_viaje_comunicacion',
      ]) {
        expect(await rechazoDeBase(appDb.query(sql))).toMatch(/permission denied/);
      }
      const yaDecidido = (
        await admin.query(
          'SELECT id FROM flota.gerenciamiento_viaje WHERE decision IS NOT NULL AND conductor_id = $1 LIMIT 1',
          [CONDUCTOR.id],
        )
      ).rows[0].id;
      expect(
        await rechazoDeBase(
          appDb.query(
            "UPDATE flota.gerenciamiento_viaje SET decision = 'autorizado', decidido_por = $2, decidido_at = now() WHERE id = $1",
            [yaDecidido, SUPERVISOR.id],
          ),
        ),
      ).toMatch(/ya tiene una decisión/);
    });

    it('la decisión exige quién, cuándo y un motivo al rechazar; y no la toma el mismo conductor', async () => {
      expect(
        await rechazoDeBase(
          appDb.query(
            "UPDATE flota.gerenciamiento_viaje SET decision = 'rechazado', decidido_por = $2, decidido_at = now(), motivo_decision = 'no' WHERE id = $1",
            [viaje, SUPERVISOR.id],
          ),
        ),
      ).toMatch(/decision_check/);
      expect(
        await rechazoDeBase(
          appDb.query(
            "UPDATE flota.gerenciamiento_viaje SET decision = 'autorizado' WHERE id = $1",
            [viaje],
          ),
        ),
      ).toMatch(/decision_check/);
      expect(
        await rechazoDeBase(
          appDb.query(
            "UPDATE flota.gerenciamiento_viaje SET decision = 'autorizado', decidido_por = conductor_id, decidido_at = now() WHERE id = $1",
            [viaje],
          ),
        ),
      ).toMatch(/decide_otro_check/);
    });

    it('el origen y el destino son una base o un pozo, nunca ambos ni ninguno; una opción debe ser de su pregunta', async () => {
      const insertar = (origenBodega: string | null, origenPozo: string | null) =>
        admin.query(
          `INSERT INTO flota.gerenciamiento_viaje (id, tipo, conductor_id, unidad_id, fecha, motivo, origen_bodega_id, origen_pozo_id,
                                                   destino_pozo_id, puntaje_total, nivel, created_by)
           VALUES ($1, 'salida', $2, $3, current_date, 'Prueba', $4, $5, $6, 0, 'bajo', $2)`,
          [uuidv7(), CONDUCTOR_2.id, unidadId, origenBodega, origenPozo, pozoId],
        );
      expect(await rechazoDeBase(insertar(bodegaId, pozoId))).toMatch(/origen_check/);
      expect(await rechazoDeBase(insertar(null, null))).toMatch(/origen_check/);
      expect(
        await rechazoDeBase(
          admin.query(
            'INSERT INTO flota.gerenciamiento_viaje_respuesta (gerenciamiento_id, pregunta_id, opcion_id) VALUES ($1, $2, $3)',
            [viaje, preguntas[0].id, preguntas[1].opciones[0].id],
          ),
        ),
      ).toMatch(/respuesta_opcion_fkey|duplicate key/);
    });

    it('un solo gerenciamiento vigente por ticket, tipo y unidad (el rechazado deja el lugar libre; otra unidad tiene el suyo)', async () => {
      expect(
        await rechazoDeBase(
          admin.query(
            `INSERT INTO flota.gerenciamiento_viaje (id, tipo, ticket_id, conductor_id, unidad_id, fecha, motivo, origen_bodega_id,
                                                     destino_pozo_id, puntaje_total, nivel, created_by)
             VALUES ($1, 'salida', $2, $3, $4, current_date, 'Prueba', $5, $6, 0, 'bajo', $3)`,
            [uuidv7(), tickets[0], CONDUCTOR.id, unidadId, bodegaId, pozoId],
          ),
        ),
      ).toMatch(/ticket_tipo_unidad_vigente_key/);
      // cada conductor solicita el de su unidad: otra unidad del mismo ticket y tipo sí cabe
      await admin.query(
        `INSERT INTO flota.gerenciamiento_viaje (id, tipo, ticket_id, conductor_id, unidad_id, fecha, motivo, origen_bodega_id,
                                                 destino_pozo_id, puntaje_total, nivel, created_by)
         VALUES ($1, 'salida', $2, $3, $4, current_date, 'Prueba', $5, $6, 0, 'bajo', $3)`,
        [uuidv7(), tickets[0], CONDUCTOR_2.id, servicioId, bodegaId, pozoId],
      );
    });

    it('el conductor solo solicita la unidad que se le asignó en el ticket', async () => {
      const ajeno = await solicitar(cuerpo({ ticketId: tickets[3] }), conductor2());
      expect([ajeno.status, ajeno.body.code]).toEqual([409, 'conductor_no_asignado']);
    });
  });
});
