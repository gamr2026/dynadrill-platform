/**
 * Integración real de encuestas (administración): Postgres (PgBouncer, app_plataforma) y las reglas de la base. Crea y limpia sus datos.
 * Requiere la semilla (`npm run db:seed:encuestas`): módulo `fcr`, escala de satisfacción y encuesta de FCR.
 *   RUN_INTEGRATION=1 npx nx test encuestas
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
import { EncuestasModule } from './encuestas.module';
import { InvitacionesService } from './services/invitaciones.service';
import { hashDeToken } from './services/token';

const run = process.env['RUN_INTEGRATION'] ? describe : describe.skip;

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const APP_DB =
  process.env['TEST_PLATAFORMA_DATABASE_URL'] ??
  'postgresql://app_plataforma:dev_app_plataforma@localhost:6432/dynadrill?pgbouncer=true';
const MIGRATOR_DB =
  process.env['TEST_MIGRATOR_DATABASE_URL'] ??
  'postgresql://dyn_migrator:dev_dyn_migrator@localhost:5433/dynadrill';

const n = Date.now();
const ADMIN = { id: uuidv7(), nombre: `Admin Encuestas ${n}` };
const P = Permission;

run('Encuestas: administración y reglas de la base (base de datos real)', () => {
  jest.setTimeout(60000);
  let app: INestApplication;
  const admin = new Pool({ connectionString: MIGRATOR_DB, max: 2 });
  const appPool = new Pool({ connectionString: APP_DB, max: 2 });
  const http = () => request(app.getHttpServer());
  const signer = new JwtService({
    privateKey,
    signOptions: { algorithm: 'RS256', issuer: 'dynadrill-plataforma', expiresIn: 600 },
  });
  const token = (roleCode: string, permissions: string[], sub = ADMIN.id) => ({
    Authorization: `Bearer ${signer.sign({ sub, email: 'x@test.local', name: ADMIN.nombre, roleId: 'r', roleCode, permissions })}`,
  });
  const superadmin = () => token('superadmin', [P.ENCUESTAS_GESTIONAR]);
  const sinPermiso = () => token('supervisor', []);
  const q = (r: { body: { detail?: string; message?: string } }) =>
    String(r.body.detail ?? r.body.message);

  const codigos: string[] = [];
  const invitacionIds: string[] = [];
  let invitaciones: InvitacionesService;
  let escalaId = '';
  const crear = async (extra: Record<string, unknown> = {}) => {
    const codigo = `t_enc_${n}_${codigos.length}`;
    codigos.push(codigo);
    const r = await http()
      .post('/api/encuestas')
      .set(superadmin())
      .send({
        codigo,
        nombre: `Encuesta de prueba ${codigos.length}`,
        moduloCodigo: 'fcr',
        ...extra,
      })
      .expect(201);
    return { codigo, id: r.body.id as string, versionId: r.body.versiones[0].id as string };
  };
  const preguntas = (versionId: string, cuerpo: unknown, auth = superadmin()) =>
    http()
      .put(`/api/encuestas/versiones/${versionId}/preguntas`)
      .set(auth)
      .send({ preguntas: cuerpo });
  const completas = () => [
    { texto: 'Califique el servicio', tipo: 'escala', obligatoria: true, escalaId },
    { texto: 'Comentarios', tipo: 'texto', obligatoria: false },
    { texto: '¿Volvería a contratarnos?', tipo: 'si_no', obligatoria: true },
    { texto: '¿Qué equipo usó?', tipo: 'opcion_unica', obligatoria: true, opciones: ['A', 'B'] },
    {
      texto: '¿Qué áreas mejorar?',
      tipo: 'opcion_multiple',
      obligatoria: false,
      opciones: ['Tiempos', 'Trato', 'Costos'],
    },
  ];
  const rechaza = async (sql: string, params: unknown[], patron: RegExp, pool: Pool = admin) => {
    await expect(pool.query(sql, params)).rejects.toThrow(patron);
  };

  beforeAll(async () => {
    const rol = await admin.query("SELECT id FROM identidad.rol WHERE codigo = 'superadmin'");
    await admin.query(
      `INSERT INTO identidad.usuario (id, email, username, nombre, rol_id, activo)
       VALUES ($1, $2, $3, $4, $5, true) ON CONFLICT (id) DO NOTHING`,
      [ADMIN.id, `${ADMIN.id}@test.local`, ADMIN.id, ADMIN.nombre, rol.rows[0].id],
    );
    Object.assign(process.env, {
      SERVICE_NAME: 'plataforma-test',
      PORT: '3198',
      LOG_LEVEL: 'silent',
      DATABASE_URL: APP_DB,
      JWT_PUBLIC_KEY: publicKey,
    });
    const envSchema = defineEnv(baseEnvSchema, databaseEnvSchema, jwtVerifyEnvSchema);
    @Module({
      imports: [
        AppConfigModule.forRoot(envSchema),
        CommonModule.forRoot({ serviceName: 'plataforma-test' }),
        MessagingModule.forRoot({
          container: 'plataforma',
          schema: 'msg_plataforma',
          rabbitUrl: 'amqp://x:x@localhost:5672',
          databaseUrl: APP_DB,
          relay: { enabled: false },
        }),
        EncuestasModule,
      ],
    })
    class TestAppModule {}
    const mod = await Test.createTestingModule({ imports: [TestAppModule] }).compile();
    app = mod.createNestApplication();
    configureApp(app, { corsOrigins: ['http://localhost:4200'] });
    await app.init();
    invitaciones = app.get(InvitacionesService);
    const escalas = (await http().get('/api/encuestas/escalas').set(superadmin()).expect(200)).body;
    escalaId = escalas.find((e: { codigo: string }) => e.codigo === 'satisfaccion_1_5').id;
  });

  afterAll(async () => {
    if (invitacionIds.length) {
      await admin.query(
        "DELETE FROM msg_plataforma.outbox WHERE datos->'data'->>'invitacionId' = ANY($1::text[])",
        [invitacionIds],
      );
      await admin.query(
        'DELETE FROM encuestas.respuesta WHERE respuesta_encuesta_id IN (SELECT id FROM encuestas.respuesta_encuesta WHERE invitacion_id = ANY($1::uuid[]))',
        [invitacionIds],
      );
      await admin.query(
        'DELETE FROM encuestas.respuesta_encuesta WHERE invitacion_id = ANY($1::uuid[])',
        [invitacionIds],
      );
      await admin.query('DELETE FROM encuestas.invitacion WHERE id = ANY($1::uuid[])', [
        invitacionIds,
      ]);
    }
    if (codigos.length) {
      // las versiones se borran enteras (con sus preguntas y opciones) y después las encuestas
      await admin.query(
        'DELETE FROM encuestas.encuesta_version WHERE encuesta_id IN (SELECT id FROM encuestas.encuesta WHERE codigo = ANY($1::text[]))',
        [codigos],
      );
      await admin.query('DELETE FROM encuestas.encuesta WHERE codigo = ANY($1::text[])', [codigos]);
    }
    await admin.query('DELETE FROM identidad.usuario WHERE id = $1', [ADMIN.id]);
    await admin.end();
    await appPool.end();
    await app.close();
  });

  describe('permisos y catálogos', () => {
    it('solo quien tiene encuestas.administracion.gestionar entra a la administración', async () => {
      for (const ruta of ['', '/modulos', '/escalas']) {
        await http().get(`/api/encuestas${ruta}`).set(sinPermiso()).expect(403);
      }
      await http().post('/api/encuestas').set(sinPermiso()).send({}).expect(403);
      await http().get('/api/encuestas').expect(401);
    });

    it('lista los módulos, las escalas con sus valores y la encuesta de FCR sembrada, con su versión vigente', async () => {
      const modulos = (await http().get('/api/encuestas/modulos').set(superadmin()).expect(200))
        .body;
      expect(modulos).toEqual(expect.arrayContaining([expect.objectContaining({ codigo: 'fcr' })]));
      const escalas = (await http().get('/api/encuestas/escalas').set(superadmin()).expect(200))
        .body;
      const satisfaccion = escalas.find((e: { codigo: string }) => e.codigo === 'satisfaccion_1_5');
      expect(satisfaccion.valores.map((v: { valor: number }) => v.valor)).toEqual([1, 2, 3, 4, 5]);
      const lista = (await http().get('/api/encuestas?modulo=fcr').set(superadmin()).expect(200))
        .body;
      const fcr = lista.find((e: { codigo: string }) => e.codigo === 'fcr_satisfaccion');
      expect(fcr).toMatchObject({ moduloCodigo: 'fcr', activa: true });
      expect(fcr.vigente).toMatchObject({ numero: 1 });
      const v = (
        await http().get(`/api/encuestas/versiones/${fcr.vigente.id}`).set(superadmin()).expect(200)
      ).body;
      expect(v.estado).toBe('publicada');
      expect(v.preguntas).toHaveLength(7);
      expect(v.preguntas[0]).toMatchObject({ orden: 1, tipo: 'escala', obligatoria: true });
      expect(v.preguntas[0].escala.valores).toHaveLength(5);
      expect(v.preguntas[6]).toMatchObject({ tipo: 'texto', obligatoria: false });
    });
  });

  describe('crear y armar una encuesta', () => {
    it('crea la encuesta con su primer borrador vacío y rechaza código repetido, módulo inexistente y código mal formado', async () => {
      const e = await crear();
      const detalle = (await http().get(`/api/encuestas/${e.id}`).set(superadmin()).expect(200))
        .body;
      expect(detalle.versiones).toEqual([
        expect.objectContaining({ numero: 1, estado: 'borrador', preguntas: 0 }),
      ]);
      const repetido = await http()
        .post('/api/encuestas')
        .set(superadmin())
        .send({ codigo: e.codigo, nombre: 'Otra', moduloCodigo: 'fcr' })
        .expect(409);
      expect(q(repetido)).toMatch(/Ya existe una encuesta/);
      await http()
        .post('/api/encuestas')
        .set(superadmin())
        .send({ codigo: `t_enc_${n}_x`, nombre: 'X', moduloCodigo: 'no_existe' })
        .expect(400);
      await http()
        .post('/api/encuestas')
        .set(superadmin())
        .send({ codigo: 'Con Espacios', nombre: 'X', moduloCodigo: 'fcr' })
        .expect(400);
      await http().get(`/api/encuestas/${uuidv7()}`).set(superadmin()).expect(404);
    });

    it('arma el borrador con los cinco tipos de respuesta, en el orden de la lista', async () => {
      const e = await crear();
      await http()
        .patch(`/api/encuestas/versiones/${e.versionId}`)
        .set(superadmin())
        .send({ titulo: '  Mi encuesta  ', introduccion: 'Gracias por su tiempo' })
        .expect(200);
      const r = await preguntas(e.versionId, completas()).expect(200);
      expect(r.body.titulo).toBe('Mi encuesta');
      expect(r.body.preguntas.map((p: { tipo: string }) => p.tipo)).toEqual([
        'escala',
        'texto',
        'si_no',
        'opcion_unica',
        'opcion_multiple',
      ]);
      expect(r.body.preguntas.map((p: { orden: number }) => p.orden)).toEqual([1, 2, 3, 4, 5]);
      expect(r.body.preguntas[3].opciones.map((o: { etiqueta: string }) => o.etiqueta)).toEqual([
        'A',
        'B',
      ]);
      expect(r.body.preguntas[0].escala.codigo).toBe('satisfaccion_1_5');
      // reemplazar deja solo lo nuevo
      const otra = await preguntas(e.versionId, [completas()[1]]).expect(200);
      expect(otra.body.preguntas).toHaveLength(1);
    });

    it('valida cada pregunta: escala que exista, opciones solo donde corresponden y sin repetir', async () => {
      const e = await crear();
      const mal = async (cuerpo: unknown, patron: RegExp) =>
        expect(q(await preguntas(e.versionId, cuerpo).expect(400))).toMatch(patron);
      await mal([{ texto: 'A', tipo: 'escala', obligatoria: true }], /es de escala/);
      await mal(
        [{ texto: 'A', tipo: 'escala', obligatoria: true, escalaId: uuidv7() }],
        /es de escala/,
      );
      await mal([{ texto: 'A', tipo: 'texto', obligatoria: true, escalaId }], /no es de escala/);
      await mal(
        [{ texto: 'A', tipo: 'opcion_unica', obligatoria: true, opciones: ['Sola'] }],
        /al menos dos opciones/,
      );
      await mal(
        [{ texto: 'A', tipo: 'opcion_multiple', obligatoria: true, opciones: ['Sí', ' sí '] }],
        /repetidas/,
      );
      await mal(
        [{ texto: 'A', tipo: 'si_no', obligatoria: true, opciones: ['x', 'y'] }],
        /no es de opciones/,
      );
      await preguntas(e.versionId, [{ texto: '   ', tipo: 'texto', obligatoria: true }]).expect(
        400,
      );
      await preguntas(e.versionId, [{ texto: 'A', tipo: 'inventado', obligatoria: true }]).expect(
        400,
      );
      await preguntas(e.versionId, 'no-es-una-lista').expect(400);
    });
  });

  describe('publicar y versionar', () => {
    it('no publica sin preguntas; publica con preguntas; y una versión publicada no se edita', async () => {
      const e = await crear();
      const vacio = await http()
        .post(`/api/encuestas/versiones/${e.versionId}/publicar`)
        .set(superadmin())
        .expect(400);
      expect(q(vacio)).toMatch(/no tiene preguntas/);
      await preguntas(e.versionId, completas()).expect(200);
      const pub = await http()
        .post(`/api/encuestas/versiones/${e.versionId}/publicar`)
        .set(superadmin())
        .expect(201);
      expect(pub.body).toMatchObject({ estado: 'publicada', numero: 1 });
      expect(pub.body.publicadaAt).toBeTruthy();
      expect(q(await preguntas(e.versionId, completas()).expect(409))).toMatch(/no se modifica/);
      await http()
        .patch(`/api/encuestas/versiones/${e.versionId}`)
        .set(superadmin())
        .send({ titulo: 'Cambio' })
        .expect(409);
      await http()
        .post(`/api/encuestas/versiones/${e.versionId}/publicar`)
        .set(superadmin())
        .expect(409);
    });

    it('un borrador copia la versión vigente; al publicarlo la anterior queda archivada y solo hay una vigente', async () => {
      const e = await crear();
      await preguntas(e.versionId, completas()).expect(200);
      await http()
        .post(`/api/encuestas/versiones/${e.versionId}/publicar`)
        .set(superadmin())
        .expect(201);
      const borrador = (
        await http().post(`/api/encuestas/${e.id}/borrador`).set(superadmin()).expect(201)
      ).body;
      expect(borrador).toMatchObject({ numero: 2, estado: 'borrador' });
      expect(borrador.preguntas).toHaveLength(5);
      expect(borrador.preguntas[3].opciones).toHaveLength(2);
      // un solo borrador a la vez
      expect(
        q(await http().post(`/api/encuestas/${e.id}/borrador`).set(superadmin()).expect(409)),
      ).toMatch(/ya tiene un borrador/);
      // se corrige el borrador sin tocar la vigente
      await preguntas(borrador.id, completas().slice(0, 2)).expect(200);
      const v1 = (
        await http().get(`/api/encuestas/versiones/${e.versionId}`).set(superadmin()).expect(200)
      ).body;
      expect(v1.preguntas).toHaveLength(5);
      await http()
        .post(`/api/encuestas/versiones/${borrador.id}/publicar`)
        .set(superadmin())
        .expect(201);
      const detalle = (await http().get(`/api/encuestas/${e.id}`).set(superadmin()).expect(200))
        .body;
      expect(
        detalle.versiones.map((v: { numero: number; estado: string }) => [v.numero, v.estado]),
      ).toEqual([
        [2, 'publicada'],
        [1, 'archivada'],
      ]);
      const lista = (await http().get('/api/encuestas').set(superadmin()).expect(200)).body;
      expect(lista.find((x: { id: string }) => x.id === e.id)).toMatchObject({
        vigente: { numero: 2 },
        borrador: null,
      });
    });

    it('una encuesta inactiva no se publica', async () => {
      const e = await crear();
      await preguntas(e.versionId, completas()).expect(200);
      await http()
        .patch(`/api/encuestas/${e.id}`)
        .set(superadmin())
        .send({ activa: false })
        .expect(200);
      expect(
        q(
          await http()
            .post(`/api/encuestas/versiones/${e.versionId}/publicar`)
            .set(superadmin())
            .expect(409),
        ),
      ).toMatch(/inactiva/);
      await http()
        .patch(`/api/encuestas/${e.id}`)
        .set(superadmin())
        .send({ activa: true, nombre: 'Renombrada' })
        .expect(200);
      await http()
        .post(`/api/encuestas/versiones/${e.versionId}/publicar`)
        .set(superadmin())
        .expect(201);
    });
  });

  describe('reglas de la base de datos (el servicio no es la única barrera)', () => {
    it('una versión publicada no admite cambios en sus preguntas ni en sus opciones, ni por SQL directo', async () => {
      const e = await crear();
      await preguntas(e.versionId, completas()).expect(200);
      await http()
        .post(`/api/encuestas/versiones/${e.versionId}/publicar`)
        .set(superadmin())
        .expect(201);
      const fila = (
        await admin.query(
          "SELECT p.id, o.id AS opcion_id FROM encuestas.pregunta p JOIN encuestas.pregunta_opcion o ON o.pregunta_id = p.id WHERE p.version_id = $1 AND p.tipo = 'opcion_unica' LIMIT 1",
          [e.versionId],
        )
      ).rows[0];
      const publicada = /versión publicada de la encuesta no se modifica/;
      await rechaza(
        "UPDATE encuestas.pregunta SET texto = 'x' WHERE id = $1",
        [fila.id],
        publicada,
        appPool,
      );
      await rechaza('DELETE FROM encuestas.pregunta WHERE id = $1', [fila.id], publicada, appPool);
      await rechaza(
        "INSERT INTO encuestas.pregunta (id, version_id, orden, texto, tipo) VALUES ($1, $2, 99, 'nueva', 'texto')",
        [uuidv7(), e.versionId],
        publicada,
        appPool,
      );
      await rechaza(
        "UPDATE encuestas.pregunta_opcion SET etiqueta = 'x' WHERE id = $1",
        [fila.opcion_id],
        publicada,
        appPool,
      );
      await rechaza(
        'DELETE FROM encuestas.pregunta_opcion WHERE id = $1',
        [fila.opcion_id],
        publicada,
        appPool,
      );
      // el título de una versión publicada tampoco cambia, ni vuelve a borrador
      await rechaza(
        "UPDATE encuestas.encuesta_version SET titulo = 'otro' WHERE id = $1",
        [e.versionId],
        publicada,
        appPool,
      );
      await rechaza(
        "UPDATE encuestas.encuesta_version SET estado = 'borrador', publicada_at = NULL, publicada_by = NULL WHERE id = $1",
        [e.versionId],
        /encuesta_version_recorrido|no vuelve a borrador|no se modifica/,
        appPool,
      );
    });

    it('la base exige coherencia: escala solo con escala, opciones solo en preguntas de opción, una vigente y un borrador por encuesta', async () => {
      const e = await crear();
      const nueva = (tipo: string, escala: string | null) =>
        appPool.query(
          'INSERT INTO encuestas.pregunta (id, version_id, orden, texto, tipo, escala_id) VALUES ($1, $2, $3, $4, $5::encuestas.tipo_respuesta, $6)',
          [uuidv7(), e.versionId, Math.floor(Math.random() * 1e6), 'Pregunta', tipo, escala],
        );
      await expect(nueva('escala', null)).rejects.toThrow(/pregunta_escala_check/);
      await expect(nueva('texto', escalaId)).rejects.toThrow(/pregunta_escala_check/);
      await nueva('texto', null); // una coherente sí entra
      const texto = (
        await admin.query(
          "SELECT id FROM encuestas.pregunta WHERE version_id = $1 AND tipo = 'texto' LIMIT 1",
          [e.versionId],
        )
      ).rows[0].id;
      // una pregunta de texto no lleva opciones (FK compuesta con el tipo + CHECK)
      await rechaza(
        "INSERT INTO encuestas.pregunta_opcion (id, pregunta_id, pregunta_tipo, orden, etiqueta) VALUES ($1, $2, 'texto', 1, 'x')",
        [uuidv7(), texto],
        /pregunta_opcion_tipo_check/,
        appPool,
      );
      await rechaza(
        "INSERT INTO encuestas.pregunta_opcion (id, pregunta_id, pregunta_tipo, orden, etiqueta) VALUES ($1, $2, 'opcion_unica', 1, 'x')",
        [uuidv7(), texto],
        /pregunta_opcion_pregunta_fkey/,
        appPool,
      );
      // un segundo borrador de la misma encuesta
      await rechaza(
        "INSERT INTO encuestas.encuesta_version (id, encuesta_id, numero, titulo) VALUES ($1, $2, 2, 'Otro borrador')",
        [uuidv7(), e.id],
        /encuesta_version_un_borrador_key/,
        appPool,
      );
      // no se archiva un borrador ni se publica sin preguntas por SQL directo
      await rechaza(
        "UPDATE encuestas.encuesta_version SET estado = 'archivada', publicada_at = now(), publicada_by = $2 WHERE id = $1",
        [e.versionId, ADMIN.id],
        /no se archiva/,
        appPool,
      );
    });

    it('no se publica por SQL directo una versión sin preguntas ni una pregunta de opción con una sola opción; la publicada no se duplica', async () => {
      const sinPreguntas = await crear();
      await rechaza(
        "UPDATE encuestas.encuesta_version SET estado = 'publicada', publicada_at = now(), publicada_by = $2 WHERE id = $1",
        [sinPreguntas.versionId, ADMIN.id],
        /no tiene preguntas/,
        appPool,
      );
      const e = await crear();
      await preguntas(e.versionId, completas()).expect(200);
      await http()
        .post(`/api/encuestas/versiones/${e.versionId}/publicar`)
        .set(superadmin())
        .expect(201);
      await rechaza(
        "INSERT INTO encuestas.encuesta_version (id, encuesta_id, numero, estado, titulo, publicada_at, publicada_by) VALUES ($1, $2, 2, 'publicada', 'Otra', now(), $3)",
        [uuidv7(), e.id, ADMIN.id],
        /encuesta_version_una_vigente_key/,
        appPool,
      );
    });

    it('la auditoría apunta a cuentas reales y la publicación de una versión exige quién y cuándo', async () => {
      const e = await crear();
      await rechaza(
        'UPDATE encuestas.encuesta SET updated_by = $2 WHERE id = $1',
        [e.id, uuidv7()],
        /encuesta_updated_by_fkey/,
        appPool,
      );
      await rechaza(
        "INSERT INTO encuestas.encuesta_version (id, encuesta_id, numero, estado, titulo) VALUES ($1, $2, 9, 'publicada', 'X')",
        [uuidv7(), e.id],
        /encuesta_version_publicacion_check/,
        appPool,
      );
    });
  });

  // ---------------------------------------------------------------------------------------------------------------------------------
  // E2: invitaciones, formulario público y respuestas
  // ---------------------------------------------------------------------------------------------------------------------------------
  interface PreguntaVista {
    id: string;
    tipo: string;
    opciones: Array<{ id: string; etiqueta: string }>;
  }
  /** Una encuesta propia con los cinco tipos de pregunta, publicada, y acceso a sus preguntas por tipo. */
  const publicada = async () => {
    const e = await crear();
    await preguntas(e.versionId, completas()).expect(200);
    await http()
      .post(`/api/encuestas/versiones/${e.versionId}/publicar`)
      .set(superadmin())
      .expect(201);
    const v = (
      await http().get(`/api/encuestas/versiones/${e.versionId}`).set(superadmin()).expect(200)
    ).body;
    const por = (tipo: string): PreguntaVista => {
      const p = (v.preguntas as PreguntaVista[]).find((x) => x.tipo === tipo);
      if (!p) throw new Error(`La encuesta de prueba no tiene una pregunta ${tipo}`);
      return p;
    };
    return { ...e, version: v, por };
  };
  type Publicada = Awaited<ReturnType<typeof publicada>>;
  const invitar = async (codigo: string, correo = 'Cliente@Empresa.COM') => {
    const i = await invitaciones.crear({
      encuestaCodigo: codigo,
      referenciaId: uuidv7(),
      correoDestino: correo,
    });
    invitacionIds.push(i.id);
    return i;
  };
  const formulario = (token: string) => http().get(`/api/encuestas/publico/${token}`);
  const contestar = (token: string, cuerpo: unknown) =>
    http()
      .post(`/api/encuestas/publico/${token}`)
      .send(cuerpo as object);
  const respuestasValidas = (e: Publicada) => [
    { preguntaId: e.por('escala').id, valor: 5 },
    { preguntaId: e.por('texto').id, valor: '  Excelente trabajo  ' },
    { preguntaId: e.por('si_no').id, valor: true },
    { preguntaId: e.por('opcion_unica').id, valor: e.por('opcion_unica').opciones[1].id },
    {
      preguntaId: e.por('opcion_multiple').id,
      valor: [e.por('opcion_multiple').opciones[0].id, e.por('opcion_multiple').opciones[2].id],
    },
  ];
  const contarRespuestas = async (invitacionId: string) =>
    Number(
      (
        await admin.query(
          'SELECT count(*) FROM encuestas.respuesta r JOIN encuestas.respuesta_encuesta e ON e.id = r.respuesta_encuesta_id WHERE e.invitacion_id = $1',
          [invitacionId],
        )
      ).rows[0].count,
    );
  const vencer = (invitacionId: string) =>
    admin.query(
      "UPDATE encuestas.invitacion SET created_at = now() - interval '3 days', vence_at = now() - interval '2 days' WHERE id = $1",
      [invitacionId],
    );

  describe('invitaciones', () => {
    it('crea un enlace de un día con la versión vigente; la base guarda solo el hash y el correo normalizado', async () => {
      const e = await publicada();
      const antes = Date.now();
      const i = await invitar(e.codigo);
      expect(i.token).toHaveLength(43);
      expect(i.correoDestino).toBe('cliente@empresa.com');
      const horas = (i.venceAt.getTime() - antes) / 3_600_000;
      expect(horas).toBeGreaterThan(23.9);
      expect(horas).toBeLessThan(24.1);
      const fila = (await admin.query('SELECT * FROM encuestas.invitacion WHERE id = $1', [i.id]))
        .rows[0];
      expect(fila.token_hash).toBe(hashDeToken(i.token));
      expect(JSON.stringify(fila)).not.toContain(i.token);
      expect(fila.version_id).toBe(e.versionId);
      expect(fila.modulo_codigo).toBe('fcr');
      expect(fila.enviada_at).toBeNull();
      // dos invitaciones nunca comparten token
      expect((await invitar(e.codigo)).token).not.toBe(i.token);
    });

    it('rechaza un correo inválido, una encuesta inexistente, inactiva o sin versión publicada', async () => {
      const e = await publicada();
      const crearCon = (encuestaCodigo: string, correoDestino = 'a@b.co') =>
        invitaciones.crear({ encuestaCodigo, referenciaId: uuidv7(), correoDestino });
      await expect(crearCon(e.codigo, 'no-es-correo')).rejects.toThrow(
        /correo indicado no es válido/,
      );
      await expect(crearCon('no_existe_xyz')).rejects.toThrow(/no existe/);
      const borrador = await crear();
      await expect(crearCon(borrador.codigo)).rejects.toThrow(/no tiene una versión publicada/);
      await http()
        .patch(`/api/encuestas/${e.id}`)
        .set(superadmin())
        .send({ activa: false })
        .expect(200);
      await expect(crearCon(e.codigo)).rejects.toThrow(/inactiva/);
    });

    it('marca el resultado del envío: enviada borra el error, y un error borra la marca de enviada', async () => {
      const e = await publicada();
      const i = await invitar(e.codigo);
      const estado = async () =>
        (
          await admin.query(
            'SELECT enviada_at, envio_error FROM encuestas.invitacion WHERE id = $1',
            [i.id],
          )
        ).rows[0];
      await invitaciones.marcarError(i.id, 'SMTP caído');
      expect(await estado()).toEqual({ enviada_at: null, envio_error: 'SMTP caído' });
      await invitaciones.marcarEnviada(i.id);
      const ok = await estado();
      expect(ok.enviada_at).toBeInstanceOf(Date);
      expect(ok.envio_error).toBeNull();
    });

    it('la base solo envía versiones publicadas y no deja cambiar el destino, el token ni la vigencia', async () => {
      const e = await publicada();
      const borrador = await crear();
      const i = await invitar(e.codigo);
      const nueva = (versionId: string, o: { hash?: string; correo?: string; vence?: Date } = {}) =>
        appPool.query(
          `INSERT INTO encuestas.invitacion (id, version_id, modulo_codigo, referencia_id, token_hash, correo_destino, vence_at)
           VALUES ($1, $2, 'fcr', $3, $4, $5, $6)`,
          [
            uuidv7(),
            versionId,
            uuidv7(),
            o.hash ?? hashDeToken(uuidv7()),
            o.correo ?? 'a@b.co',
            o.vence ?? new Date(Date.now() + 3_600_000),
          ],
        );
      await expect(nueva(borrador.versionId)).rejects.toThrow(
        /Solo se envía una versión publicada/,
      );
      await expect(nueva(e.versionId, { hash: 'no-es-un-hash' })).rejects.toThrow(
        /invitacion_token_check/,
      );
      await expect(nueva(e.versionId, { correo: 'sin-arroba' })).rejects.toThrow(
        /invitacion_correo_check/,
      );
      await expect(nueva(e.versionId, { vence: new Date(Date.now() - 60_000) })).rejects.toThrow(
        /invitacion_vigencia_check/,
      );
      await rechaza(
        "UPDATE encuestas.invitacion SET correo_destino = 'otro@x.co' WHERE id = $1",
        [i.id],
        /permission denied/,
        appPool,
      );
      await rechaza(
        "UPDATE encuestas.invitacion SET vence_at = now() + interval '30 days' WHERE id = $1",
        [i.id],
        /permission denied/,
        appPool,
      );
      await rechaza(
        "UPDATE encuestas.invitacion SET token_hash = repeat('a', 64) WHERE id = $1",
        [i.id],
        /permission denied/,
        appPool,
      );
      await rechaza(
        'DELETE FROM encuestas.invitacion WHERE id = $1',
        [i.id],
        /permission denied/,
        appPool,
      );
      // lo único que sí se actualiza es el resultado del envío
      await appPool.query('UPDATE encuestas.invitacion SET enviada_at = now() WHERE id = $1', [
        i.id,
      ]);
    });
  });

  describe('formulario público', () => {
    it('muestra las preguntas sin ningún dato del servicio ni del correo, y no exige sesión', async () => {
      const e = await publicada();
      const i = await invitar(e.codigo);
      const r = await formulario(i.token).expect(200);
      expect(r.body.titulo).toBeTruthy();
      expect(r.body.preguntas).toHaveLength(5);
      expect(r.body.preguntas[0]).toMatchObject({ tipo: 'escala', obligatoria: true });
      expect(r.body.preguntas[0].escala.map((v: { valor: number }) => v.valor)).toEqual([
        1, 2, 3, 4, 5,
      ]);
      expect(r.body.preguntas[3].opciones).toHaveLength(2);
      const texto = JSON.stringify(r.body).toLowerCase();
      for (const secreto of ['cliente@empresa.com', i.id, 'referencia', 'correo', 'tokenhash']) {
        expect(texto).not.toContain(secreto.toLowerCase());
      }
    });

    it('un enlace inexistente, mal formado o de otra forma responde 404 sin pistas', async () => {
      const e = await publicada();
      const i = await invitar(e.codigo);
      const otro = i.token.slice(0, -1) + (i.token.endsWith('A') ? 'B' : 'A');
      for (const malo of [otro, 'corto', 'x'.repeat(43), i.id]) {
        const r = await formulario(malo).expect(404);
        expect(q(r)).toBe('El enlace de la encuesta no es válido');
        await contestar(malo, { nombre: 'X', respuestas: [] }).expect(404);
      }
    });

    it('guarda lo contestado con los cinco tipos, una sola vez, y publica el evento sin datos personales', async () => {
      const e = await publicada();
      const i = await invitar(e.codigo);
      const r = await contestar(i.token, {
        nombre: '  Marta Quishpe ',
        cargo: 'Company Man',
        respuestas: respuestasValidas(e),
      }).expect(201);
      expect(r.body).toEqual({ ok: true, mensaje: 'Gracias por responder la encuesta' });
      expect(await contarRespuestas(i.id)).toBe(6); // la múltiple guarda una fila por opción elegida
      const filas = (
        await admin.query(
          `SELECT p.tipo, r.valor_numero, r.valor_texto, r.valor_booleano
           FROM encuestas.respuesta r JOIN encuestas.pregunta p ON p.id = r.pregunta_id
           JOIN encuestas.respuesta_encuesta re ON re.id = r.respuesta_encuesta_id
           WHERE re.invitacion_id = $1 ORDER BY p.orden`,
          [i.id],
        )
      ).rows;
      expect(filas[0]).toMatchObject({ tipo: 'escala', valor_numero: 5 });
      expect(filas[1]).toMatchObject({ tipo: 'texto', valor_texto: 'Excelente trabajo' });
      expect(filas[2]).toMatchObject({ tipo: 'si_no', valor_booleano: true });
      const cab = (
        await admin.query(
          'SELECT nombre_respondiente, cargo_respondiente FROM encuestas.respuesta_encuesta WHERE invitacion_id = $1',
          [i.id],
        )
      ).rows[0];
      expect(cab).toEqual({
        nombre_respondiente: 'Marta Quishpe',
        cargo_respondiente: 'Company Man',
      });
      const evento = (
        await admin.query(
          "SELECT tipo, datos FROM msg_plataforma.outbox WHERE datos->'data'->>'invitacionId' = $1",
          [i.id],
        )
      ).rows;
      expect(evento).toHaveLength(1);
      expect(evento[0].tipo).toBe('plataforma.encuesta.respondida');
      expect(evento[0].datos.data).toMatchObject({
        invitacionId: i.id,
        encuestaCodigo: e.codigo,
        moduloCodigo: 'fcr',
      });
      expect(JSON.stringify(evento[0].datos)).not.toMatch(/Marta|Company Man|cliente@empresa/i);
      // un solo uso
      const otra = await contestar(i.token, {
        nombre: 'Otra',
        respuestas: respuestasValidas(e),
      }).expect(410);
      expect(q(otra)).toMatch(/ya fue respondida/);
      expect(q(await formulario(i.token).expect(410))).toMatch(/ya fue respondida/);
      expect(await contarRespuestas(i.id)).toBe(6);
    });

    it('rechaza lo incompleto o mal formado y no guarda nada', async () => {
      const e = await publicada();
      const i = await invitar(e.codigo);
      const ok = respuestasValidas(e);
      const mal = async (cuerpo: unknown, patron: RegExp) =>
        expect(q(await contestar(i.token, cuerpo).expect(400))).toMatch(patron);
      await mal({ nombre: 'Marta', respuestas: [] }, /Falta responder/);
      await mal(
        { nombre: 'Marta', respuestas: ok.slice(1) },
        /Falta responder: «Califique el servicio»/,
      );
      await mal(
        { nombre: 'Marta', respuestas: ok.map((r, k) => (k === 0 ? { ...r, valor: 9 } : r)) },
        /elija un valor de la escala/,
      );
      await mal(
        { nombre: 'Marta', respuestas: ok.map((r, k) => (k === 2 ? { ...r, valor: 'sí' } : r)) },
        /responda sí o no/,
      );
      await mal(
        { nombre: 'Marta', respuestas: [...ok, { preguntaId: uuidv7(), valor: 1 }] },
        /no corresponde a esta encuesta/,
      );
      await mal({ nombre: 'Marta', respuestas: [...ok, ok[0]] }, /respondida dos veces/);
      await mal({ nombre: '   ', respuestas: ok }, /nombre/);
      await contestar(i.token, { respuestas: ok }).expect(400);
      await contestar(i.token, { nombre: 'Marta', respuestas: 'no-es-lista' }).expect(400);
      await contestar(i.token, {
        nombre: 'Marta',
        respuestas: [{ preguntaId: 'no-uuid', valor: 1 }],
      }).expect(400);
      expect(await contarRespuestas(i.id)).toBe(0);
      const cabeceras = await admin.query(
        'SELECT 1 FROM encuestas.respuesta_encuesta WHERE invitacion_id = $1',
        [i.id],
      );
      expect(cabeceras.rowCount).toBe(0);
      // y el enlace sigue sirviendo
      await contestar(i.token, { nombre: 'Marta', respuestas: ok }).expect(201);
    });

    it('un enlace vencido no se muestra ni se contesta', async () => {
      const e = await publicada();
      const i = await invitar(e.codigo);
      await vencer(i.id);
      expect(q(await formulario(i.token).expect(410))).toMatch(/venció/);
      expect(
        q(
          await contestar(i.token, { nombre: 'Marta', respuestas: respuestasValidas(e) }).expect(
            410,
          ),
        ),
      ).toMatch(/venció/);
      expect(await contarRespuestas(i.id)).toBe(0);
    });

    it('dos envíos a la vez: uno se guarda y el otro recibe «ya respondida»', async () => {
      const e = await publicada();
      const i = await invitar(e.codigo);
      const cuerpo = { nombre: 'Marta', respuestas: respuestasValidas(e) };
      const rs = await Promise.all([contestar(i.token, cuerpo), contestar(i.token, cuerpo)]);
      expect(rs.map((r) => r.status).sort()).toEqual([201, 410]);
      expect(await contarRespuestas(i.id)).toBe(6);
    });

    it('la nueva versión de la encuesta no cambia lo que ya se envió', async () => {
      const e = await publicada();
      const i = await invitar(e.codigo);
      const borrador = (
        await http().post(`/api/encuestas/${e.id}/borrador`).set(superadmin()).expect(201)
      ).body;
      await preguntas(borrador.id, [
        { texto: 'Solo una', tipo: 'texto', obligatoria: true },
      ]).expect(200);
      await http()
        .post(`/api/encuestas/versiones/${borrador.id}/publicar`)
        .set(superadmin())
        .expect(201);
      // el cliente sigue viendo y contestando la versión 1 con la que se le invitó
      expect((await formulario(i.token).expect(200)).body.preguntas).toHaveLength(5);
      await contestar(i.token, { nombre: 'Marta', respuestas: respuestasValidas(e) }).expect(201);
      // la invitación nueva usa la vigente
      const j = await invitar(e.codigo);
      expect((await formulario(j.token).expect(200)).body.preguntas).toHaveLength(1);
    });
  });

  describe('consulta de lo enviado y respondido (administración)', () => {
    it('lista con filtros y estado, y detalla cada pregunta con su respuesta', async () => {
      const e = await publicada();
      const sin = await invitar(e.codigo);
      const resp = await invitar(e.codigo, 'otro@cliente.com');
      const vencida = await invitar(e.codigo);
      await vencer(vencida.id);
      await contestar(resp.token, {
        nombre: 'Marta',
        cargo: 'Company Man',
        respuestas: respuestasValidas(e),
      }).expect(201);

      const lista = async (consulta: string) =>
        (
          await http()
            .get(`/api/encuestas/invitaciones?encuestaId=${e.id}${consulta}`)
            .set(superadmin())
            .expect(200)
        ).body;
      const ids = (r: { items: Array<{ id: string }> }) => r.items.map((x) => x.id);
      const todas = await lista('');
      expect(todas.total).toBe(3);
      const estados = Object.fromEntries(
        todas.items.map((x: { id: string; estado: string }) => [x.id, x.estado]),
      );
      expect(estados).toEqual({
        [sin.id]: 'pendiente',
        [resp.id]: 'respondida',
        [vencida.id]: 'vencida',
      });
      expect(ids(await lista('&estado=respondida'))).toEqual([resp.id]);
      expect(ids(await lista('&estado=pendiente'))).toEqual([sin.id]);
      expect(ids(await lista('&estado=vencida'))).toEqual([vencida.id]);
      expect((await lista('&limite=1&desplazamiento=1')).items).toHaveLength(1);
      const respondida = todas.items.find((x: { id: string }) => x.id === resp.id);
      expect(respondida).toMatchObject({
        correoDestino: 'otro@cliente.com',
        moduloCodigo: 'fcr',
        respondiente: { nombre: 'Marta', cargo: 'Company Man' },
      });

      const d = (
        await http().get(`/api/encuestas/invitaciones/${resp.id}`).set(superadmin()).expect(200)
      ).body;
      expect(d.estado).toBe('respondida');
      expect(d.respuestas.map((x: { tipo: string }) => x.tipo)).toEqual([
        'escala',
        'texto',
        'si_no',
        'opcion_unica',
        'opcion_multiple',
      ]);
      expect(d.respuestas[0].valor).toEqual({ valor: 5, etiqueta: 'Excelente' });
      expect(d.respuestas[1].valor).toBe('Excelente trabajo');
      expect(d.respuestas[2].valor).toBe(true);
      expect(d.respuestas[3].valor.etiqueta).toBe('B');
      expect(d.respuestas[4].valor.map((o: { etiqueta: string }) => o.etiqueta)).toEqual([
        'Tiempos',
        'Costos',
      ]);
      // una invitación sin responder trae las preguntas con valor nulo
      const vacia = (
        await http().get(`/api/encuestas/invitaciones/${sin.id}`).set(superadmin()).expect(200)
      ).body;
      expect(vacia.respuestas.every((x: { valor: unknown }) => x.valor === null)).toBe(true);
      await http().get(`/api/encuestas/invitaciones/${uuidv7()}`).set(superadmin()).expect(404);
    });

    it('solo el Superadmin ve el correo y las respuestas', async () => {
      await http().get('/api/encuestas/invitaciones').set(sinPermiso()).expect(403);
      await http().get(`/api/encuestas/invitaciones/${uuidv7()}`).set(sinPermiso()).expect(403);
      await http().get('/api/encuestas/invitaciones').expect(401);
      await http()
        .get('/api/encuestas/invitaciones?estado=inventado')
        .set(superadmin())
        .expect(400);
    });
  });

  describe('reglas de la base sobre las respuestas', () => {
    it('las respuestas son inmutables y un enlace no se usa dos veces, ni por SQL directo', async () => {
      const e = await publicada();
      const i = await invitar(e.codigo);
      await contestar(i.token, { nombre: 'Marta', respuestas: respuestasValidas(e) }).expect(201);
      const una = (
        await admin.query(
          'SELECT r.id FROM encuestas.respuesta r JOIN encuestas.respuesta_encuesta re ON re.id = r.respuesta_encuesta_id WHERE re.invitacion_id = $1 LIMIT 1',
          [i.id],
        )
      ).rows[0].id;
      await rechaza(
        "UPDATE encuestas.respuesta SET valor_texto = 'x' WHERE id = $1",
        [una],
        /permission denied/,
        appPool,
      );
      await rechaza(
        'DELETE FROM encuestas.respuesta WHERE id = $1',
        [una],
        /permission denied/,
        appPool,
      );
      await rechaza(
        "UPDATE encuestas.respuesta_encuesta SET nombre_respondiente = 'Otro' WHERE invitacion_id = $1",
        [i.id],
        /permission denied/,
        appPool,
      );
      await rechaza(
        'DELETE FROM encuestas.respuesta_encuesta WHERE invitacion_id = $1',
        [i.id],
        /permission denied/,
        appPool,
      );
      await rechaza(
        "INSERT INTO encuestas.respuesta_encuesta (id, invitacion_id, nombre_respondiente) VALUES ($1, $2, 'Otra')",
        [uuidv7(), i.id],
        /respuesta_encuesta_invitacion_key/,
        appPool,
      );
    });

    it('rechaza una respuesta de otra versión, un valor fuera de la escala, el tipo equivocado, dos opciones en la única y dos valores en una fila', async () => {
      const e = await publicada();
      const otra = await publicada();
      const i = await invitar(e.codigo);
      const rid = uuidv7();
      const c = await appPool.connect();
      try {
        await c.query('BEGIN');
        await c.query(
          'INSERT INTO encuestas.respuesta_encuesta (id, invitacion_id, nombre_respondiente) VALUES ($1, $2, $3)',
          [rid, i.id, 'Prueba'],
        );
        /** Cada intento corre en un punto de guardado: un rechazo no aborta la transacción de la prueba. */
        const ins = async (
          preguntaId: string,
          col: string,
          valor: unknown,
          opcion: string | null = null,
        ) => {
          await c.query('SAVEPOINT s');
          try {
            await c.query(
              `INSERT INTO encuestas.respuesta (id, respuesta_encuesta_id, pregunta_id, ${col}, opcion_id) VALUES ($1, $2, $3, $4, $5)`,
              [uuidv7(), rid, preguntaId, valor, opcion],
            );
            await c.query('RELEASE SAVEPOINT s');
          } catch (err) {
            await c.query('ROLLBACK TO SAVEPOINT s');
            throw err;
          }
        };
        await expect(ins(otra.por('escala').id, 'valor_numero', 3)).rejects.toThrow(
          /no pertenece a la encuesta enviada/,
        );
        await expect(ins(e.por('escala').id, 'valor_numero', 9)).rejects.toThrow(
          /no es parte de la escala/,
        );
        await expect(ins(e.por('escala').id, 'valor_texto', 'cinco')).rejects.toThrow(
          /no es parte de la escala/,
        );
        await expect(ins(e.por('texto').id, 'valor_numero', 3)).rejects.toThrow(
          /se responde con texto/,
        );
        await expect(ins(e.por('si_no').id, 'valor_texto', 'sí')).rejects.toThrow(/sí o no/);
        const [a, b] = e.por('opcion_unica').opciones;
        await ins(e.por('opcion_unica').id, 'valor_numero', null, a.id);
        await expect(ins(e.por('opcion_unica').id, 'valor_numero', null, b.id)).rejects.toThrow(
          /una sola opción/,
        );
        // la opción de otra pregunta no vale (FK compuesta)
        await expect(
          ins(
            e.por('opcion_multiple').id,
            'valor_numero',
            null,
            e.por('opcion_unica').opciones[0].id,
          ),
        ).rejects.toThrow(/respuesta_opcion_fkey/);
        // la múltiple admite varias, pero no la misma dos veces
        const m = e.por('opcion_multiple');
        await ins(m.id, 'valor_numero', null, m.opciones[0].id);
        await ins(m.id, 'valor_numero', null, m.opciones[1].id);
        await expect(ins(m.id, 'valor_numero', null, m.opciones[1].id)).rejects.toThrow(
          /respuesta_opcion_key/,
        );
        // dos valores en una misma fila
        await expect(
          c.query(
            'INSERT INTO encuestas.respuesta (id, respuesta_encuesta_id, pregunta_id, valor_numero, valor_texto) VALUES ($1, $2, $3, 3, $4)',
            [uuidv7(), rid, e.por('escala').id, 'x'],
          ),
        ).rejects.toThrow(/respuesta_un_valor_check/);
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        c.release();
      }
    });

    it('al terminar la transacción exige todas las preguntas obligatorias, y no admite respuestas después del vencimiento', async () => {
      const e = await publicada();
      const i = await invitar(e.codigo);
      const c = await appPool.connect();
      try {
        await c.query('BEGIN');
        await c.query(
          "INSERT INTO encuestas.respuesta_encuesta (id, invitacion_id, nombre_respondiente) VALUES ($1, $2, 'Prueba')",
          [uuidv7(), i.id],
        );
        // sin ninguna respuesta: la obligatoria falta y el COMMIT lo rechaza
        await expect(c.query('COMMIT')).rejects.toThrow(/pregunta obligatoria/);
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        c.release();
      }
      expect(await contarRespuestas(i.id)).toBe(0);
      await vencer(i.id);
      await rechaza(
        "INSERT INTO encuestas.respuesta_encuesta (id, invitacion_id, nombre_respondiente) VALUES ($1, $2, 'Tarde')",
        [uuidv7(), i.id],
        /venció/,
        appPool,
      );
      const otra = await invitar(e.codigo);
      await rechaza(
        "INSERT INTO encuestas.respuesta_encuesta (id, invitacion_id, nombre_respondiente) VALUES ($1, $2, '   ')",
        [uuidv7(), otra.id],
        /respuesta_encuesta_nombre_check/,
        appPool,
      );
    });
  });
});
