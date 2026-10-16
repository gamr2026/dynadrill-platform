/**
 * Integración real del módulo: Postgres (vía PgBouncer, usuario app_plataforma).
 *   npm run infra:up && npm run db:migrate:catalogos && npm run db:migrate-demo:catalogos
 *   RUN_INTEGRATION=1 npx nx test catalogos
 * Los datos de prueba llevan el prefijo `it-` y se eliminan al final con dyn_migrator (la aplicación no
 * tiene DELETE). Las pruebas de "datos migrados" suponen que la migración desde la demo ya se ejecutó.
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
  rabbitEnvSchema,
} from '@dyn/config';
import { CommonModule, configureApp } from '@dyn/common';
import { MessagingModule } from '@dyn/messaging';
import { uuidv7 } from '@dyn/utils';
import { CatalogosModule } from './index';
import { PrismaService } from './prisma/prisma.service';
import { quitarMaestros, sembrarMaestros, type MaestrosDePrueba } from './testing/maestros';

const run = process.env['RUN_INTEGRATION'] ? describe : describe.skip;

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const APP_DB =
  process.env['TEST_DATABASE_URL'] ??
  'postgresql://app_plataforma:dev_app_plataforma@localhost:6432/dynadrill?pgbouncer=true';
const MIGRATOR_DB =
  process.env['TEST_MIGRATOR_DATABASE_URL'] ??
  'postgresql://dyn_migrator:dev_dyn_migrator@localhost:5433/dynadrill';

const tag = `it-${Date.now()}`;
const ACTOR = uuidv7();
/** Cuentas reales: quién creó, modificó o subió cada registro es FK a `identidad.usuario`. */
const MAESTROS: MaestrosDePrueba = {
  usuarios: [{ id: ACTOR, nombre: 'Actor de prueba', rol: 'superadmin' }],
};

const P = Permission;
const TODOS_UBICACION = [P.UBICACION_CREAR, P.UBICACION_EDITAR, P.UBICACION_INACTIVAR];
const TODOS_CLIENTES = [P.CLIENTES_CREAR, P.CLIENTES_EDITAR, P.CLIENTES_INACTIVAR];
const TODOS_PERSONAS = [P.PERSONAS_CREAR, P.PERSONAS_EDITAR, P.PERSONAS_INACTIVAR];

run('catalogos (base de datos real)', () => {
  jest.setTimeout(60000);
  let app: INestApplication;
  let prisma: PrismaService;
  const admin = new Pool({ connectionString: MIGRATOR_DB, max: 2 });
  const http = () => request(app.getHttpServer());
  const signer = new JwtService({
    privateKey,
    signOptions: { algorithm: 'RS256', issuer: 'dynadrill-plataforma', expiresIn: 600 },
  });
  const token = (permissions: string[] = []) =>
    signer.sign({
      sub: ACTOR,
      email: 'it@test.local',
      roleId: 'r',
      roleCode: 'operador',
      permissions,
    });
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
  /** Usuario con todos los permisos de escritura de catálogos. */
  const admToken = () => token([...TODOS_UBICACION, ...TODOS_CLIENTES, ...TODOS_PERSONAS]);

  beforeAll(async () => {
    await sembrarMaestros(admin, MAESTROS);
    Object.assign(process.env, {
      SERVICE_NAME: 'catalogos-test',
      PORT: '3197',
      LOG_LEVEL: 'silent',
      DATABASE_URL: APP_DB,
      RABBITMQ_URL: 'amqp://x:x@localhost:5672',
      JWT_PUBLIC_KEY: publicKey,
    });
    const envSchema = defineEnv(
      baseEnvSchema,
      databaseEnvSchema,
      jwtVerifyEnvSchema,
      rabbitEnvSchema,
    );

    @Module({
      imports: [
        AppConfigModule.forRoot(envSchema),
        CommonModule.forRoot({ serviceName: 'catalogos-test' }),
        // relay apagado: estas pruebas solo verifican que el evento quede en el outbox
        MessagingModule.forRoot({
          container: 'plataforma',
          schema: 'msg_plataforma',
          rabbitUrl: 'amqp://x:x@localhost:5672',
          databaseUrl: APP_DB,
          relay: { enabled: false },
        }),
        CatalogosModule,
      ],
    })
    class TestAppModule {}

    const mod = await Test.createTestingModule({ imports: [TestAppModule] }).compile();
    app = mod.createNestApplication();
    configureApp(app, { corsOrigins: ['http://localhost:4200'] });
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    const like = `${tag}%`;
    // outbox primero (los eventos apuntan por id a las filas de prueba)
    await admin.query(
      `DELETE FROM msg_plataforma.outbox WHERE datos->'data'->>'id' IN (
         SELECT id::text FROM catalogos.pozo WHERE codigo LIKE $1
         UNION ALL SELECT id::text FROM catalogos.campo WHERE nombre LIKE $1
         UNION ALL SELECT id::text FROM catalogos.bloque WHERE nombre LIKE $1
         UNION ALL SELECT id::text FROM catalogos.taladro WHERE nombre LIKE $1
         UNION ALL SELECT id::text FROM catalogos.cliente WHERE identificacion LIKE $1
         UNION ALL SELECT id::text FROM catalogos.persona_contacto WHERE nombre LIKE $1)`,
      [like],
    );
    await admin.query('DELETE FROM catalogos.pozo WHERE codigo LIKE $1', [like]);
    await admin.query('DELETE FROM catalogos.campo WHERE nombre LIKE $1', [like]);
    await admin.query('DELETE FROM catalogos.zona WHERE nombre LIKE $1', [like]);
    await admin.query('DELETE FROM catalogos.chofer WHERE licencia LIKE $1', [like]);
    await admin.query(
      'DELETE FROM catalogos.vehiculo WHERE transportista_id IN (SELECT id FROM catalogos.transportista WHERE nombre_fiscal LIKE $1)',
      [like],
    );
    await admin.query('DELETE FROM catalogos.transportista WHERE nombre_fiscal LIKE $1', [like]);
    await admin.query('DELETE FROM catalogos.tipo_vehiculo WHERE nombre LIKE $1', [like]);
    await admin.query('DELETE FROM catalogos.bodega WHERE nombre LIKE $1', [like]);
    await admin.query('DELETE FROM catalogos.condicion_pago WHERE nombre LIKE $1', [like]);
    await admin.query('DELETE FROM catalogos.bloque WHERE nombre LIKE $1', [like]);
    await admin.query('DELETE FROM catalogos.taladro WHERE nombre LIKE $1', [like]);
    await admin.query('DELETE FROM catalogos.cliente WHERE identificacion LIKE $1', [like]);
    await admin.query('DELETE FROM catalogos.persona_contacto WHERE nombre LIKE $1', [like]);
    await quitarMaestros(admin, MAESTROS);
    await admin.end();
    await app.close();
  });

  describe('lectura abierta a cualquier usuario autenticado', () => {
    it('sin token da 401; con un token sin ningún permiso lista los seis catálogos', async () => {
      await http().get('/api/catalogos/bloques').expect(401);
      const t = token([]); // autenticado, sin permisos
      for (const ruta of ['bloques', 'campos', 'taladros', 'pozos', 'clientes', 'personas']) {
        const res = await http().get(`/api/catalogos/${ruta}`).set(bearer(t)).expect(200);
        expect(Array.isArray(res.body)).toBe(true);
      }
    });

    it('devuelve las formas que lee el frontend: pozo con campo y bloque anidados, y `activo` del campo es texto', async () => {
      const t = token([]);
      const pozos = (await http().get('/api/catalogos/pozos').set(bearer(t)).expect(200)).body;
      expect(pozos.length).toBeGreaterThanOrEqual(1103);
      expect(pozos[0]).toEqual({
        id: expect.any(String),
        legacyId: expect.any(Number),
        codigo: expect.any(String),
        nombreCompleto: expect.any(String),
        campoId: expect.any(String),
        bloqueId: expect.any(String),
        habilitado: expect.any(Boolean),
        campo: expect.objectContaining({ id: expect.any(String), nombre: expect.any(String) }),
        bloque: expect.objectContaining({ id: expect.any(String), nombre: expect.any(String) }),
      });
      expect(pozos[0].campoId).toBe(pozos[0].campo.id);

      const campos = (await http().get('/api/catalogos/campos').set(bearer(t)).expect(200)).body;
      const conZona = campos.find((c: { zona: string | null }) => c.zona !== null);
      expect(conZona).toEqual(
        expect.objectContaining({
          legacyId: expect.any(Number),
          zona: expect.any(String),
          zonaId: expect.any(String),
          habilitado: true,
        }),
      );
    });

    it('un id mal formado da 400 y uno inexistente 404', async () => {
      const t = token([]);
      await http().get('/api/catalogos/clientes/no-es-uuid').set(bearer(t)).expect(400);
      await http().get(`/api/catalogos/clientes/${uuidv7()}`).set(bearer(t)).expect(404);
    });
  });

  describe('datos migrados desde la demo', () => {
    it('toda fila migrada conserva su id numérico (legacy_id) y los conteos coinciden con la demo', async () => {
      const q = async (sql: string) => Number((await admin.query(sql)).rows[0].n);
      expect(
        await q(
          `SELECT count(*) n FROM catalogos.pozo WHERE legacy_id IS NULL AND codigo NOT LIKE 'it-%'`,
        ),
      ).toBe(0);
      expect(
        await q(
          `SELECT count(*) n FROM catalogos.cliente WHERE legacy_id IS NULL AND identificacion NOT LIKE 'it-%'`,
        ),
      ).toBe(0);
      expect(await q(`SELECT count(*) n FROM catalogos.bloque WHERE legacy_id IS NOT NULL`)).toBe(
        18,
      );
      expect(await q(`SELECT count(*) n FROM catalogos.campo WHERE legacy_id IS NOT NULL`)).toBe(
        82,
      );
      expect(await q(`SELECT count(*) n FROM catalogos.taladro WHERE legacy_id IS NOT NULL`)).toBe(
        71,
      );
      expect(await q(`SELECT count(*) n FROM catalogos.pozo WHERE legacy_id IS NOT NULL`)).toBe(
        1103,
      );
      expect(await q(`SELECT count(*) n FROM catalogos.cliente WHERE legacy_id IS NOT NULL`)).toBe(
        61,
      );
      expect(
        await q(`SELECT count(*) n FROM catalogos.persona_contacto WHERE legacy_id IS NOT NULL`),
      ).toBe(123);
    });

    it('cada pozo migrado apunta al campo y al bloque correctos (integridad referencial real)', async () => {
      const huerfanos = await admin.query(
        `SELECT count(*)::int n FROM catalogos.pozo p
           LEFT JOIN catalogos.campo c ON c.id = p.campo_id
           LEFT JOIN catalogos.bloque b ON b.id = p.bloque_id
          WHERE c.id IS NULL OR b.id IS NULL`,
      );
      expect(huerfanos.rows[0].n).toBe(0);
    });
  });

  describe('cada escritura exige su permiso', () => {
    const casos: Array<{
      ruta: string;
      crear: object;
      permisos: { crear: string; editar: string; inactivar: string };
    }> = [
      {
        ruta: 'bloques',
        crear: { nombre: `${tag}-perm-bloque` },
        permisos: {
          crear: P.UBICACION_CREAR,
          editar: P.UBICACION_EDITAR,
          inactivar: P.UBICACION_INACTIVAR,
        },
      },
      {
        ruta: 'taladros',
        crear: { nombre: `${tag}-perm-taladro` },
        permisos: {
          crear: P.UBICACION_CREAR,
          editar: P.UBICACION_EDITAR,
          inactivar: P.UBICACION_INACTIVAR,
        },
      },
      {
        ruta: 'clientes',
        crear: {
          tipoIdentificacion: 'Ruc',
          identificacion: `${tag}-perm-cli`,
          nombreComercial: 'Cliente de prueba',
        },
        permisos: {
          crear: P.CLIENTES_CREAR,
          editar: P.CLIENTES_EDITAR,
          inactivar: P.CLIENTES_INACTIVAR,
        },
      },
      {
        ruta: 'personas',
        crear: { tipo: 'agente_comercial', nombre: `${tag}-perm-persona` },
        permisos: {
          crear: P.PERSONAS_CREAR,
          editar: P.PERSONAS_EDITAR,
          inactivar: P.PERSONAS_INACTIVAR,
        },
      },
    ];

    it.each(casos)(
      '$ruta: sin permiso 403; con crear/editar/inactivar cada acción pasa por separado',
      async ({ ruta, crear, permisos }) => {
        const base = `/api/catalogos/${ruta}`;
        const sin = token([]);
        await http().post(base).set(bearer(sin)).send(crear).expect(403);

        // solo crear: crea, pero no edita ni inactiva
        const soloCrear = token([permisos.crear]);
        const creado = await http().post(base).set(bearer(soloCrear)).send(crear).expect(201);
        const id = creado.body.id as string;
        await http().put(`${base}/${id}`).set(bearer(soloCrear)).send({}).expect(403);
        await http().delete(`${base}/${id}`).set(bearer(soloCrear)).expect(403);

        // solo editar: edita, no inactiva
        const soloEditar = token([permisos.editar]);
        await http().put(`${base}/${id}`).set(bearer(soloEditar)).send({}).expect(200);
        await http().post(base).set(bearer(soloEditar)).send(crear).expect(403);
        await http().delete(`${base}/${id}`).set(bearer(soloEditar)).expect(403);

        // solo inactivar: inactiva, no edita
        const soloInactivar = token([permisos.inactivar]);
        await http().put(`${base}/${id}`).set(bearer(soloInactivar)).send({}).expect(403);
        await http().delete(`${base}/${id}`).set(bearer(soloInactivar)).expect(200, { ok: true });
      },
    );

    it('editar no sirve para saltarse inactivar: poner habilitado:false exige ese permiso, reactivar solo editar', async () => {
      const creado = (
        await http()
          .post('/api/catalogos/bloques')
          .set(bearer(admToken()))
          .send({ nombre: `${tag}-atajo` })
          .expect(201)
      ).body;
      const soloEditar = token([P.UBICACION_EDITAR]);
      const r = await http()
        .put(`/api/catalogos/bloques/${creado.id}`)
        .set(bearer(soloEditar))
        .send({ habilitado: false });
      expect(r.status).toBe(403);
      expect(JSON.stringify(r.body.message)).toContain('catalogos.ubicacion.inactivar');
      expect((await prisma.bloque.findUniqueOrThrow({ where: { id: creado.id } })).habilitado).toBe(
        true,
      );

      // con editar + inactivar sí; y reactivar solo exige editar
      const ambos = token([P.UBICACION_EDITAR, P.UBICACION_INACTIVAR]);
      await http()
        .put(`/api/catalogos/bloques/${creado.id}`)
        .set(bearer(ambos))
        .send({ habilitado: false })
        .expect(200);
      const reactivado = await http()
        .put(`/api/catalogos/bloques/${creado.id}`)
        .set(bearer(soloEditar))
        .send({ habilitado: true });
      expect(reactivado.status).toBe(200);
      expect(reactivado.body.habilitado).toBe(true);
    });
  });

  describe('ubicación: bloque, campo, pozo y taladro', () => {
    it('ciclo completo de un pozo con su campo y su bloque, con auditoría y evento en el outbox', async () => {
      const t = admToken();
      const bloque = (
        await http()
          .post('/api/catalogos/bloques')
          .set(bearer(t))
          .send({ nombre: `${tag}-b1` })
          .expect(201)
      ).body;
      expect(bloque).toEqual({
        id: expect.any(String),
        legacyId: null,
        nombre: `${tag}-b1`,
        habilitado: true,
      });

      // bodegas y condiciones de pago: catálogos con id (y `as2Id` para enlazar lo que viene de AS2)
      for (const [ruta, nombre] of [
        ['bodegas', `${tag}-BODEGA`],
        ['condiciones-pago', `${tag}-30 dias`],
      ] as const) {
        const creada = (
          await http()
            .post(`/api/catalogos/${ruta}`)
            .set(bearer(t))
            .send({ nombre, as2Id: 987654 + ruta.length })
            .expect(201)
        ).body;
        expect(creada).toMatchObject({ nombre, as2Id: 987654 + ruta.length, habilitado: true });
        await http()
          .post(`/api/catalogos/${ruta}`)
          .set(bearer(t))
          .send({ nombre: nombre.toLowerCase() })
          .expect(409);
        const lista = (await http().get(`/api/catalogos/${ruta}`).set(bearer(t)).expect(200)).body;
        expect(lista.map((x: { id: string }) => x.id)).toContain(creada.id);
        // lectura por id (la usa `comercial` para validar lo que elige el pedido)
        expect(
          (await http().get(`/api/catalogos/${ruta}/${creada.id}`).set(bearer(t)).expect(200)).body,
        ).toMatchObject({ id: creada.id, nombre });
        await http()
          .get(`/api/catalogos/${ruta}/018f0000-0000-7000-8000-000000000000`)
          .set(bearer(t))
          .expect(404);
        await http().delete(`/api/catalogos/${ruta}/${creada.id}`).set(bearer(t)).expect(200);
      }

      // la zona es un catálogo con su id; el campo la referencia por clave foránea
      const zona = (
        await http()
          .post('/api/catalogos/zonas')
          .set(bearer(t))
          .send({ nombre: `${tag}-ZONA` })
          .expect(201)
      ).body;
      await http()
        .post('/api/catalogos/zonas')
        .set(bearer(t))
        .send({ nombre: `${tag}-zona` })
        .expect(409); // mismo nombre sin distinguir mayúsculas
      expect(
        (await http().get(`/api/catalogos/zonas/${zona.id}`).set(bearer(t)).expect(200)).body,
      ).toMatchObject({ id: zona.id });
      await http()
        .post('/api/catalogos/campos')
        .set(bearer(t))
        .send({ nombre: `${tag}-c0`, zonaId: '018f0000-0000-7000-8000-000000000000' })
        .expect(400); // una zona que no existe

      const campo = (
        await http()
          .post('/api/catalogos/campos')
          .set(bearer(t))
          .send({ nombre: `${tag}-c1`, zonaId: zona.id })
          .expect(201)
      ).body;
      expect(campo).toMatchObject({
        nombre: `${tag}-c1`,
        zona: `${tag}-ZONA`,
        zonaId: zona.id,
        habilitado: true,
      });
      const enBase = await admin.query('SELECT zona_id FROM catalogos.campo WHERE id = $1', [
        campo.id,
      ]);
      expect(enBase.rows[0]).toEqual({ zona_id: zona.id });

      const pozo = (
        await http()
          .post('/api/catalogos/pozos')
          .set(bearer(t))
          .send({
            codigo: `${tag}-p1`,
            nombreCompleto: 'POZO DE PRUEBA',
            campoId: campo.id,
            bloqueId: bloque.id,
          })
          .expect(201)
      ).body;
      expect(pozo).toMatchObject({
        campoId: campo.id,
        bloqueId: bloque.id,
        habilitado: true,
        legacyId: null,
      });
      expect(pozo.campo.nombre).toBe(`${tag}-c1`);
      expect(pozo.bloque.nombre).toBe(`${tag}-b1`);

      // auditoría: quién lo creó
      const fila = await admin.query(
        'SELECT created_by, updated_by FROM catalogos.pozo WHERE id = $1',
        [pozo.id],
      );
      expect(fila.rows[0]).toEqual({ created_by: ACTOR, updated_by: ACTOR });

      // evento en el outbox, en la misma transacción
      const ev = await admin.query(
        `SELECT datos FROM msg_plataforma.outbox WHERE datos->'data'->>'id' = $1`,
        [pozo.id],
      );
      expect(ev.rowCount).toBe(1);
      expect(ev.rows[0].datos).toMatchObject({
        type: 'plataforma.catalogo.actualizado',
        version: 1,
        source: 'plataforma',
        data: { catalogo: 'pozo', id: pozo.id, cambio: 'creado' },
      });

      // edición y filtros por campo / bloque
      const editado = (
        await http()
          .put(`/api/catalogos/pozos/${pozo.id}`)
          .set(bearer(t))
          .send({ nombreCompleto: 'POZO RENOMBRADO' })
          .expect(200)
      ).body;
      expect(editado.nombreCompleto).toBe('POZO RENOMBRADO');
      const porCampo = (
        await http().get(`/api/catalogos/pozos?campoId=${campo.id}`).set(bearer(t)).expect(200)
      ).body;
      expect(porCampo.map((p: { id: string }) => p.id)).toEqual([pozo.id]);
      const porBloque = (
        await http().get(`/api/catalogos/pozos?bloqueId=${bloque.id}`).set(bearer(t)).expect(200)
      ).body;
      expect(porBloque).toHaveLength(1);
      await http().get('/api/catalogos/pozos?campoId=no-es-uuid').set(bearer(t)).expect(400);

      // "borrar" inactiva y no elimina; es idempotente y deja el evento "inactivado" una sola vez
      await http()
        .delete(`/api/catalogos/pozos/${pozo.id}`)
        .set(bearer(t))
        .expect(200, { ok: true });
      await http()
        .delete(`/api/catalogos/pozos/${pozo.id}`)
        .set(bearer(t))
        .expect(200, { ok: true });
      expect((await prisma.pozo.findUniqueOrThrow({ where: { id: pozo.id } })).habilitado).toBe(
        false,
      );
      const inact = await admin.query(
        `SELECT 1 FROM msg_plataforma.outbox WHERE datos->'data'->>'id' = $1 AND datos->'data'->>'cambio' = 'inactivado'`,
        [pozo.id],
      );
      expect(inact.rowCount).toBe(1);
    });

    it('un pozo con campo o bloque inexistente da 400 con mensaje claro', async () => {
      const t = admToken();
      const bloque = (
        await http()
          .post('/api/catalogos/bloques')
          .set(bearer(t))
          .send({ nombre: `${tag}-b2` })
          .expect(201)
      ).body;
      const campo = (
        await http()
          .post('/api/catalogos/campos')
          .set(bearer(t))
          .send({ nombre: `${tag}-c2` })
          .expect(201)
      ).body;
      const r1 = await http()
        .post('/api/catalogos/pozos')
        .set(bearer(t))
        .send({ codigo: `${tag}-p2`, nombreCompleto: 'X', campoId: uuidv7(), bloqueId: bloque.id })
        .expect(400);
      expect(r1.body.message).toBe('El campo indicado no existe');
      const r2 = await http()
        .post('/api/catalogos/pozos')
        .set(bearer(t))
        .send({ codigo: `${tag}-p2`, nombreCompleto: 'X', campoId: campo.id, bloqueId: uuidv7() })
        .expect(400);
      expect(r2.body.message).toBe('El bloque indicado no existe');
      expect(
        (await admin.query('SELECT 1 FROM catalogos.pozo WHERE codigo = $1', [`${tag}-p2`]))
          .rowCount,
      ).toBe(0);
    });

    it('transporte de la guía: transportista, tipo de vehículo, vehículo y chofer son catálogos distintos y relacionados', async () => {
      const t = token([P.TRANSPORTE_CREAR, P.TRANSPORTE_EDITAR, P.TRANSPORTE_INACTIVAR]);
      const crear = (ruta: string, cuerpo: object) =>
        http().post(`/api/catalogos/${ruta}`).set(bearer(t)).send(cuerpo);
      const tr = (
        await crear('transportistas', {
          nombreFiscal: `${tag}-DYNADRILL`,
          tipoIdentificacion: 'ruc',
          identificacion: `${tag}-1792142350001`,
          codigo: `${tag}-GRAL`,
        }).expect(201)
      ).body;
      expect(tr).toMatchObject({
        nombreFiscal: `${tag}-DYNADRILL`,
        tipoIdentificacion: 'ruc',
        habilitado: true,
      });
      await crear('transportistas', {
        nombreFiscal: 'Otro',
        tipoIdentificacion: 'ruc',
        identificacion: `${tag}-1792142350001`,
      }).expect(409);
      await crear('transportistas', {
        nombreFiscal: 'Otro',
        tipoIdentificacion: 'licencia',
        identificacion: '123456789',
      }).expect(400);

      const tipo = (await crear('tipos-vehiculo', { nombre: `${tag}-CAMION` }).expect(201)).body;
      await crear('tipos-vehiculo', { nombre: `${tag}-camion` }).expect(409);

      // la placa se normaliza (mayúsculas, sin guiones ni espacios) y es única
      const ve = (
        await crear('vehiculos', {
          placa: `${tag.slice(-4)}-6538`.toLowerCase().replace(/[^a-z0-9-]/g, 'x'),
          marca: 'JAC',
          anio: 2017,
          tipoVehiculoId: tipo.id,
          transportistaId: tr.id,
        }).expect(201)
      ).body;
      expect(ve.placa).toMatch(/^[A-Z0-9]{5,8}$/);
      expect(ve).toMatchObject({
        marca: 'JAC',
        anio: 2017,
        tipoVehiculo: { id: tipo.id },
        transportista: { id: tr.id },
      });
      await crear('vehiculos', { placa: ve.placa.toLowerCase() }).expect(409);
      await crear('vehiculos', { placa: 'AB' }).expect(400);
      await crear('vehiculos', {
        placa: 'ZZZ9999',
        tipoVehiculoId: '018f0000-0000-7000-8000-000000000000',
      }).expect(400);

      // el chofer pertenece a un transportista (como en AS2)
      const ch = (
        await crear('choferes', {
          transportistaId: tr.id,
          licencia: `${tag}-LIC1`,
          nombre: 'Chofer Uno',
        }).expect(201)
      ).body;
      await crear('choferes', {
        transportistaId: tr.id,
        licencia: `${tag}-LIC1`,
        nombre: 'Repetido',
      }).expect(409);
      await crear('choferes', {
        transportistaId: '018f0000-0000-7000-8000-000000000000',
        licencia: 'XXX111',
        nombre: 'Sin transportista',
      }).expect(400);
      const delTransportista = (
        await http()
          .get(`/api/catalogos/choferes?transportistaId=${tr.id}`)
          .set(bearer(token([])))
          .expect(200)
      ).body;
      expect(delTransportista.map((c: { id: string }) => c.id)).toEqual([ch.id]);
      expect(
        (
          await http()
            .get(`/api/catalogos/vehiculos?transportistaId=${tr.id}`)
            .set(bearer(token([])))
            .expect(200)
        ).body,
      ).toHaveLength(1);
      expect(
        (
          await http()
            .get(`/api/catalogos/transportistas/${tr.id}`)
            .set(bearer(token([])))
            .expect(200)
        ).body.id,
      ).toBe(tr.id);

      // inactivar no borra (las guías ya emitidas los referencian); sin permiso no se puede
      await http()
        .delete(`/api/catalogos/choferes/${ch.id}`)
        .set(bearer(token([P.TRANSPORTE_CREAR])))
        .expect(403);
      await http().delete(`/api/catalogos/choferes/${ch.id}`).set(bearer(t)).expect(200);
      expect(
        (
          await http()
            .get(`/api/catalogos/choferes/${ch.id}`)
            .set(bearer(token([])))
            .expect(200)
        ).body.habilitado,
      ).toBe(false);
    });

    it('nombres y códigos repetidos dan 409 y no escriben nada', async () => {
      const t = admToken();
      await http()
        .post('/api/catalogos/taladros')
        .set(bearer(t))
        .send({ nombre: `${tag}-t-dup`, rigContractual: 'RIG-1' })
        .expect(201);
      const dup = await http()
        .post('/api/catalogos/taladros')
        .set(bearer(t))
        .send({ nombre: `${tag}-t-dup` });
      expect(dup.status).toBe(409);
      expect(JSON.stringify(dup.body.message)).toMatch(/nombre/);
      expect(
        (await admin.query('SELECT 1 FROM catalogos.taladro WHERE nombre = $1', [`${tag}-t-dup`]))
          .rowCount,
      ).toBe(1);
    });

    it('rechaza campos extra, tipos inválidos y cuerpos vacíos', async () => {
      const t = admToken();
      await http()
        .post('/api/catalogos/bloques')
        .set(bearer(t))
        .send({ nombre: `${tag}-x`, admin: true })
        .expect(400);
      await http().post('/api/catalogos/bloques').set(bearer(t)).send({}).expect(400);
      await http()
        .post('/api/catalogos/campos')
        .set(bearer(t))
        .send({ nombre: `${tag}-y`, habilitado: 'si' })
        .expect(400);
    });
  });

  describe('clientes y personas de contacto', () => {
    it('ciclo de un cliente: identificación única, nombre fiscal opcional, inactivar sin borrar', async () => {
      const t = admToken();
      const cli = (
        await http()
          .post('/api/catalogos/clientes')
          .set(bearer(t))
          .send({
            tipoIdentificacion: 'Ruc',
            identificacion: `${tag}-0991234567001`,
            nombreComercial: 'Operadora de Prueba',
          })
          .expect(201)
      ).body;
      expect(cli).toEqual({
        id: expect.any(String),
        legacyId: null,
        tipoIdentificacion: 'Ruc',
        identificacion: `${tag}-0991234567001`,
        nombreComercial: 'Operadora de Prueba',
        nombreFiscal: null,
        activo: true,
      });
      const dup = await http().post('/api/catalogos/clientes').set(bearer(t)).send({
        tipoIdentificacion: 'Ruc',
        identificacion: cli.identificacion,
        nombreComercial: 'Otra',
      });
      expect(dup.status).toBe(409);

      const upd = (
        await http()
          .put(`/api/catalogos/clientes/${cli.id}`)
          .set(bearer(t))
          .send({ nombreFiscal: 'OPERADORA DE PRUEBA S.A.' })
          .expect(200)
      ).body;
      expect(upd.nombreFiscal).toBe('OPERADORA DE PRUEBA S.A.');

      await http()
        .delete(`/api/catalogos/clientes/${cli.id}`)
        .set(bearer(t))
        .expect(200, { ok: true });
      const fila = await prisma.cliente.findUniqueOrThrow({ where: { id: cli.id } });
      expect(fila.activo).toBe(false); // la fila sigue ahí
    });

    it('personas: el tipo se valida, el filtro ?tipo funciona y (tipo, nombre) es único', async () => {
      const t = admToken();
      const nombre = `${tag}-Ing. Prueba`;
      const p = (
        await http()
          .post('/api/catalogos/personas')
          .set(bearer(t))
          .send({ tipo: 'representante_campo', nombre, cedula: '1700000001' })
          .expect(201)
      ).body;
      expect(p).toMatchObject({
        tipo: 'representante_campo',
        nombre,
        cedula: '1700000001',
        activo: true,
        legacyId: null,
      });

      // mismo nombre en OTRO tipo es válido; en el mismo tipo, 409
      await http()
        .post('/api/catalogos/personas')
        .set(bearer(t))
        .send({ tipo: 'representante_quito', nombre })
        .expect(201);
      await http()
        .post('/api/catalogos/personas')
        .set(bearer(t))
        .send({ tipo: 'representante_campo', nombre })
        .expect(409);

      await http()
        .post('/api/catalogos/personas')
        .set(bearer(t))
        .send({ tipo: 'inventado', nombre: `${tag}-z` })
        .expect(400);
      await http().get('/api/catalogos/personas?tipo=inventado').set(bearer(t)).expect(400);

      const campo = (
        await http()
          .get('/api/catalogos/personas?tipo=representante_campo')
          .set(bearer(t))
          .expect(200)
      ).body;
      expect(campo.length).toBeGreaterThanOrEqual(59);
      expect(campo.every((x: { tipo: string }) => x.tipo === 'representante_campo')).toBe(true);
      // sin cédula, la propiedad no aparece (igual que la demo)
      const quito = (
        await http()
          .get('/api/catalogos/personas?tipo=representante_quito')
          .set(bearer(t))
          .expect(200)
      ).body;
      expect(quito.find((x: { nombre: string }) => x.nombre === nombre)).not.toHaveProperty(
        'cedula',
      );
    });

    it('la base impide un tipo de persona inválido aunque se salte la API', async () => {
      await expect(
        admin.query(
          `INSERT INTO catalogos.persona_contacto (id, tipo, nombre) VALUES ($1, 'inventado', $2)`,
          [uuidv7(), `${tag}-check`],
        ),
      ).rejects.toThrow(/invalid input value for enum .*tipo_persona/);
    });
  });

  describe('inmutabilidad: la aplicación no puede borrar filas de catálogos', () => {
    it('ni con Prisma ni con SQL directo (no tiene DELETE); solo se inactiva', async () => {
      const bloque = (
        await http()
          .post('/api/catalogos/bloques')
          .set(bearer(admToken()))
          .send({ nombre: `${tag}-nodel` })
          .expect(201)
      ).body;
      await expect(prisma.bloque.delete({ where: { id: bloque.id } })).rejects.toThrow();
      await expect(
        prisma.$executeRawUnsafe('DELETE FROM catalogos.cliente WHERE false'),
      ).rejects.toThrow(/permission denied/i);
      expect(
        (await admin.query('SELECT 1 FROM catalogos.bloque WHERE id = $1', [bloque.id])).rowCount,
      ).toBe(1);
    });
  });
});
