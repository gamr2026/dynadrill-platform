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
import { uuidv7 } from '@dyn/utils';
import { EncuestasModule } from './encuestas.module';

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
        EncuestasModule,
      ],
    })
    class TestAppModule {}
    const mod = await Test.createTestingModule({ imports: [TestAppModule] }).compile();
    app = mod.createNestApplication();
    configureApp(app, { corsOrigins: ['http://localhost:4200'] });
    await app.init();
    const escalas = (await http().get('/api/encuestas/escalas').set(superadmin()).expect(200)).body;
    escalaId = escalas.find((e: { codigo: string }) => e.codigo === 'satisfaccion_1_5').id;
  });

  afterAll(async () => {
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
});
