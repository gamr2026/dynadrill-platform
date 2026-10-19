/**
 * Integración real del módulo: Postgres (vía PgBouncer, usuario app_plataforma).
 *   npm run infra:up && npm run db:migrate:identidad && npm run db:seed:identidad
 *   RUN_INTEGRATION=1 npx nx test identidad
 * Los datos de prueba llevan el prefijo `it-` y se eliminan al final con dyn_migrator
 * (la aplicación no tiene DELETE).
 */
import { INestApplication, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { generateKeyPairSync } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import { Pool } from 'pg';
import request from 'supertest';
import {
  AppConfigModule,
  baseEnvSchema,
  databaseEnvSchema,
  defineEnv,
  jwtVerifyEnvSchema,
  rabbitEnvSchema,
} from '@dyn/config';
import { ALL_PERMISSION_CODES, type PermissionDef } from '@dyn/authz';
import { CommonModule, configureApp } from '@dyn/common';
import { MessagingModule } from '@dyn/messaging';
import { uuidv7 } from '@dyn/utils';
import { IdentidadModule, identidadEnvSchema } from './index';
import { syncPermisos } from './catalog/sync-permisos';
import { PrismaService } from './prisma/prisma.service';

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

const PASSWORD = 'Clave-De-Prueba-2026*';
const tag = `it-${Date.now()}`;

run('identidad (base de datos real)', () => {
  jest.setTimeout(60000);
  let app: INestApplication;
  let prisma: PrismaService;
  const admin = new Pool({ connectionString: MIGRATOR_DB, max: 2 });
  const http = () => request(app.getHttpServer());
  const roles: Record<string, string> = {};
  /** Rol creado solo para las pruebas de RBAC; se elimina al final (los roles reales no se tocan). */
  let rolPrueba: { id: string; codigo: string } | undefined;

  const email = (n: string) => `${tag}-${n}@test.local`;
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

  /** Crea un usuario directamente en la base (sin pasar por la API) con la clave de prueba. */
  async function crearUsuario(
    n: string,
    rol: string,
    extra: { hash?: string; activo?: boolean } = {},
  ) {
    return prisma.usuario.create({
      data: {
        id: uuidv7(),
        email: email(n),
        username: `${tag}-${n}`,
        nombre: `Prueba ${n}`,
        rolId: roles[rol],
        activo: extra.activo ?? true,
        passwordHash: extra.hash ?? (await bcrypt.hash(PASSWORD, 4)),
      },
    });
  }
  const login = (n: string, password = PASSWORD) =>
    http()
      .post('/api/auth/login')
      .send({ email: email(n), password });

  beforeAll(async () => {
    Object.assign(process.env, {
      SERVICE_NAME: 'identidad-test',
      PORT: '3198',
      LOG_LEVEL: 'silent',
      DATABASE_URL: APP_DB,
      RABBITMQ_URL: 'amqp://x:x@localhost:5672',
      JWT_PUBLIC_KEY: publicKey,
      JWT_PRIVATE_KEY: privateKey,
      LOGIN_MAX_ATTEMPTS: '3',
      LOGIN_LOCK_MINUTES: '15',
      DEV_ROLE_SWITCH: 'true',
    });
    const envSchema = defineEnv(
      baseEnvSchema,
      databaseEnvSchema,
      jwtVerifyEnvSchema,
      rabbitEnvSchema,
      identidadEnvSchema,
    );

    @Module({
      imports: [
        AppConfigModule.forRoot(envSchema),
        CommonModule.forRoot({ serviceName: 'identidad-test' }),
        // relay apagado: estas pruebas solo verifican que el evento quede en el outbox
        MessagingModule.forRoot({
          container: 'plataforma',
          schema: 'msg_plataforma',
          rabbitUrl: 'amqp://x:x@localhost:5672',
          databaseUrl: APP_DB,
          relay: { enabled: false },
        }),
        IdentidadModule,
      ],
    })
    class TestAppModule {}

    const mod = await Test.createTestingModule({ imports: [TestAppModule] }).compile();
    app = mod.createNestApplication();
    configureApp(app, { corsOrigins: ['http://localhost:4200'] });
    await app.init();
    prisma = app.get(PrismaService);
    for (const r of await prisma.rol.findMany()) roles[r.codigo] = r.id;
    if (!roles['superadmin'])
      throw new Error('Faltan los roles: ejecute npm run db:seed:identidad');
  });

  afterAll(async () => {
    const ids = (
      await admin.query<{ id: string }>(`SELECT id FROM identidad.usuario WHERE email LIKE $1`, [
        `${tag}-%`,
      ])
    ).rows.map((r) => r.id);
    await admin.query(
      `DELETE FROM msg_plataforma.outbox WHERE datos->'subject'->>'id' = ANY($1::text[])`,
      [ids],
    );
    await admin.query(`DELETE FROM identidad.sesion WHERE usuario_id = ANY($1::uuid[])`, [ids]);
    await admin.query(`DELETE FROM identidad.usuario_perfil WHERE usuario_id = ANY($1::uuid[])`, [
      ids,
    ]);
    await admin.query(`DELETE FROM identidad.usuario WHERE id = ANY($1::uuid[])`, [ids]);
    if (rolPrueba) {
      await admin.query(`DELETE FROM msg_plataforma.outbox WHERE datos->'subject'->>'id' = $1`, [
        rolPrueba.id,
      ]);
      await admin.query('DELETE FROM identidad.rol_permiso_historial WHERE rol_id = $1::uuid', [
        rolPrueba.id,
      ]);
      await admin.query('DELETE FROM identidad.rol_permiso WHERE rol_id = $1::uuid', [
        rolPrueba.id,
      ]);
      await admin.query('DELETE FROM identidad.rol WHERE id = $1::uuid', [rolPrueba.id]);
    }
    await admin.end();
    await app.close();
  });

  describe('login', () => {
    it('devuelve access (RS256) y refresh tokens; el refresh solo se guarda como hash', async () => {
      const u = await crearUsuario('login', 'operador');
      const res = await login('login').expect(200);
      expect(res.body.user).toMatchObject({
        id: u.id,
        email: email('login'),
        roleCode: 'operador',
        roleName: 'Operador',
      });
      expect(res.body.expiresIn).toBe(900);

      const decoded = jwt.verify(res.body.accessToken, publicKey, {
        algorithms: ['RS256'],
        complete: true,
      });
      expect(decoded.header['kid']).toBeTruthy();
      expect(decoded.payload).toMatchObject({ sub: u.id, roleCode: 'operador' });

      const { rows } = await admin.query(
        `SELECT token_hash FROM identidad.sesion WHERE usuario_id = $1`,
        [u.id],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(rows[0].token_hash).not.toBe(res.body.refreshToken);
    });

    it('puente de transición: el token y la respuesta llevan legacyId solo si el usuario existe en la demo', async () => {
      // usuario nuevo (sin equivalente en la demo): sin claims de puente
      await crearUsuario('sinlegacy', 'operador');
      const nuevo = (await login('sinlegacy').expect(200)).body;
      expect(nuevo.user).toMatchObject({ legacyId: null });
      expect(jwt.decode(nuevo.accessToken)).not.toHaveProperty('legacyId');

      // usuario migrado de la demo: id numérico propio y del rol
      const u = await crearUsuario('conlegacy', 'operador');
      const legacyId = 900000 + Math.floor(Math.random() * 99999);
      const rolLegacy = (await prisma.rol.findUniqueOrThrow({ where: { id: roles['operador'] } }))
        .legacyId;
      await admin.query(`UPDATE identidad.usuario SET legacy_id = $1 WHERE id = $2`, [
        legacyId,
        u.id,
      ]);
      const res = (await login('conlegacy').expect(200)).body;
      expect(res.user).toMatchObject({ legacyId, roleLegacyId: rolLegacy });
      const claims = jwt.decode(res.accessToken) as Record<string, unknown>;
      expect(claims['legacyId']).toBe(legacyId);
      if (rolLegacy !== null) expect(claims['legacyRoleId']).toBe(rolLegacy);

      // /roles/:code/usuarios también lo expone (los módulos viejos asignan por ese id)
      const adminUser = await crearUsuario('adminlegacy', 'superadmin');
      void adminUser;
      const tk = (await login('adminlegacy').expect(200)).body.accessToken;
      const lista = (await http().get('/api/roles/operador/usuarios').set(bearer(tk)).expect(200))
        .body;
      expect(lista.find((x: { id: string }) => x.id === u.id)).toMatchObject({ legacyId });
    });

    it('migra en silencio un hash bcrypt de la demo a Argon2id en el primer login correcto', async () => {
      const u = await crearUsuario('bcrypt', 'operador');
      expect(u.passwordHash).toMatch(/^\$2[ab]\$/);
      await login('bcrypt').expect(200);
      const after = await prisma.usuario.findUniqueOrThrow({ where: { id: u.id } });
      expect(after.passwordHash).toMatch(/^\$argon2id\$/);
      await login('bcrypt').expect(200); // y sigue entrando con el hash nuevo
    });

    it('rechaza igual (401, mismo mensaje) usuario inexistente, clave mala, inactivo y sin clave', async () => {
      await crearUsuario('inactivo', 'operador', { activo: false });
      const msgs = new Set<string>();
      for (const res of [
        await http()
          .post('/api/auth/login')
          .send({ email: email('no-existe'), password: PASSWORD }),
        await crearUsuario('mala', 'operador').then(() => login('mala', 'incorrecta')),
        await login('inactivo'),
      ]) {
        expect(res.status).toBe(401);
        msgs.add(res.body.message);
      }
      expect([...msgs]).toEqual(['Credenciales inválidas']);
    });

    it('bloquea la cuenta tras los intentos fallidos, aun con la clave correcta, y la libera al vencer', async () => {
      const u = await crearUsuario('bloqueo', 'operador');
      for (let i = 0; i < 3; i++) await login('bloqueo', 'mala').expect(401);
      const locked = await prisma.usuario.findUniqueOrThrow({ where: { id: u.id } });
      expect(locked.bloqueadoHasta!.getTime()).toBeGreaterThan(Date.now());

      const res = await login('bloqueo').expect(401); // clave correcta, cuenta bloqueada
      expect(res.body.message).toBe('Credenciales inválidas'); // no revela el bloqueo

      await admin.query(
        `UPDATE identidad.usuario SET bloqueado_hasta = now() - interval '1 minute' WHERE id = $1`,
        [u.id],
      );
      await login('bloqueo').expect(200);
      const freed = await prisma.usuario.findUniqueOrThrow({ where: { id: u.id } });
      expect(freed).toMatchObject({ intentosFallidos: 0, bloqueadoHasta: null });
    });

    it('valida el cuerpo: rechaza campos extra y email mal formado', async () => {
      await http().post('/api/auth/login').send({ email: 'x', password: 'y' }).expect(400);
      await http()
        .post('/api/auth/login')
        .send({ email: email('a'), password: 'y', admin: true })
        .expect(400);
    });
  });

  describe('refresh con rotación', () => {
    it('cambia un refresh por un par nuevo y el viejo deja de servir', async () => {
      await crearUsuario('rot', 'operador');
      const first = (await login('rot').expect(200)).body;
      const second = (
        await http()
          .post('/api/auth/refresh')
          .send({ refreshToken: first.refreshToken })
          .expect(200)
      ).body;
      expect(second.refreshToken).not.toBe(first.refreshToken);
      expect(second.accessToken).toBeTruthy();
      await http().post('/api/auth/refresh').send({ refreshToken: first.refreshToken }).expect(401);
      // reuso inmediato (dentro de la ventana de gracia) NO cierra las demás sesiones
      await http()
        .post('/api/auth/refresh')
        .send({ refreshToken: second.refreshToken })
        .expect(200);
    });

    it('reusar un refresh ya rotado (robo) cierra todas las sesiones del usuario', async () => {
      const u = await crearUsuario('robo', 'operador');
      const a = (await login('robo').expect(200)).body;
      const b = (
        await http().post('/api/auth/refresh').send({ refreshToken: a.refreshToken }).expect(200)
      ).body;
      // simula que A se rotó hace rato (fuera de la ventana de gracia)
      await admin.query(
        `UPDATE identidad.sesion SET revocado_at = now() - interval '5 minutes' WHERE usuario_id = $1 AND revocado_at IS NOT NULL`,
        [u.id],
      );

      await http().post('/api/auth/refresh').send({ refreshToken: a.refreshToken }).expect(401);
      await http().post('/api/auth/refresh').send({ refreshToken: b.refreshToken }).expect(401); // B también cayó
      const { rows } = await admin.query(
        `SELECT count(*)::int n FROM identidad.sesion WHERE usuario_id = $1 AND revocado_at IS NULL`,
        [u.id],
      );
      expect(rows[0].n).toBe(0);
    });

    it('un refresh vencido, inexistente o de un usuario desactivado no sirve', async () => {
      const u = await crearUsuario('venc', 'operador');
      const t = (await login('venc').expect(200)).body;
      await http()
        .post('/api/auth/refresh')
        .send({ refreshToken: 'x'.repeat(43) })
        .expect(401);
      await admin.query(
        `UPDATE identidad.sesion SET expira_at = now() - interval '1 second' WHERE usuario_id = $1`,
        [u.id],
      );
      await http().post('/api/auth/refresh').send({ refreshToken: t.refreshToken }).expect(401);

      await crearUsuario('off', 'operador');
      const off = (await login('off').expect(200)).body;
      await admin.query(`UPDATE identidad.usuario SET activo = false WHERE email = $1`, [
        email('off'),
      ]);
      await http().post('/api/auth/refresh').send({ refreshToken: off.refreshToken }).expect(401);
    });
  });

  describe('sesión: me, logout, switch-role, jwks', () => {
    it('me devuelve el usuario de la sesión; sin token da 401', async () => {
      const u = await crearUsuario('me', 'bodeguero');
      const t = (await login('me').expect(200)).body;
      await http().get('/api/auth/me').expect(401);
      const me = (await http().get('/api/auth/me').set(bearer(t.accessToken)).expect(200)).body;
      expect(me).toMatchObject({ id: u.id, roleCode: 'bodeguero' });
    });

    it('logout con refresh cierra solo esa sesión; sin refresh cierra todas', async () => {
      const u = await crearUsuario('out', 'operador');
      const s1 = (await login('out').expect(200)).body;
      const s2 = (await login('out').expect(200)).body;
      await http()
        .post('/api/auth/logout')
        .set(bearer(s1.accessToken))
        .send({ refreshToken: s1.refreshToken })
        .expect(200);
      await http().post('/api/auth/refresh').send({ refreshToken: s1.refreshToken }).expect(401);
      await http().post('/api/auth/refresh').send({ refreshToken: s2.refreshToken }).expect(200); // la otra sigue

      const s3 = (await login('out').expect(200)).body;
      await http().post('/api/auth/logout').set(bearer(s3.accessToken)).send({}).expect(200);
      const { rows } = await admin.query(
        `SELECT count(*)::int n FROM identidad.sesion WHERE usuario_id = $1 AND revocado_at IS NULL`,
        [u.id],
      );
      expect(rows[0].n).toBe(0);
    });

    it('switch-role (solo desarrollo) emite un token con otro rol y marcado como impersonado', async () => {
      await crearUsuario('sw', 'operador');
      const t = (await login('sw').expect(200)).body;
      const res = await http()
        .post('/api/auth/switch-role')
        .set(bearer(t.accessToken))
        .send({ roleCode: 'supervisor' })
        .expect(200);
      expect(res.body.refreshToken).toBeUndefined();
      expect(jwt.decode(res.body.accessToken)).toMatchObject({
        roleCode: 'supervisor',
        impersonated: true,
      });
      const me = (await http().get('/api/auth/me').set(bearer(res.body.accessToken)).expect(200))
        .body;
      expect(me.roleCode).toBe('supervisor');
      await http().post('/api/auth/switch-role').set(bearer(t.accessToken)).send({}).expect(400);
    });

    it('jwks es público y su kid coincide con el de los tokens', async () => {
      await crearUsuario('jwks', 'operador');
      const t = (await login('jwks').expect(200)).body;
      const { keys } = (await http().get('/api/auth/jwks').expect(200)).body;
      expect(keys[0]).toMatchObject({ kty: 'RSA', alg: 'RS256' });
      expect(keys[0].d).toBeUndefined();
      expect(jwt.decode(t.accessToken, { complete: true })!.header.kid).toBe(keys[0].kid);
    });
  });

  describe('usuarios y roles', () => {
    let adminToken: string;
    beforeAll(async () => {
      await crearUsuario('admin', 'superadmin');
      adminToken = (await login('admin').expect(200)).body.accessToken;
    });

    it('solo Superadmin administra usuarios', async () => {
      await crearUsuario('jefe', 'jefe_base');
      const jefe = (await login('jefe').expect(200)).body.accessToken;
      await http().get('/api/users').set(bearer(jefe)).expect(403);
      await http().get('/api/users').expect(401);
      await http().get('/api/users').set(bearer(adminToken)).expect(200);
    });

    it('crea un usuario sin exponer jamás el hash, con RRHH aplanado y evento en el outbox', async () => {
      const res = await http()
        .post('/api/users')
        .set(bearer(adminToken))
        .send({
          email: email('nuevo').toUpperCase(),
          username: `${tag}-nuevo`,
          password: PASSWORD,
          name: 'Usuario Nuevo',
          phone: '0991234567',
          roleId: roles['operador_mantenimiento'],
          status: true,
          specialty: 'Mecánico',
          cedula: '1712345678',
          cargo: 'Mecánico',
          fechaIngreso: '2026-01-15',
        })
        .expect(201);
      expect(res.body).toMatchObject({
        email: email('nuevo'), // normalizado a minúsculas
        name: 'Usuario Nuevo',
        phone: '0991234567',
        roleId: roles['operador_mantenimiento'],
        status: true,
        specialty: 'Mecánico',
        cedula: '1712345678',
        cargo: 'Mecánico',
      });
      expect(res.body.fechaIngreso).toMatch(/^2026-01-15/);
      expect(JSON.stringify(res.body)).not.toMatch(
        /passwordHash|password_hash|intentosFallidos|argon2/i,
      );

      const { rows } = await admin.query(
        `SELECT datos FROM msg_plataforma.outbox WHERE datos->'subject'->>'id' = $1`,
        [res.body.id],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].datos).toMatchObject({
        type: 'plataforma.usuario.actualizado',
        version: 1,
        source: 'plataforma',
        data: { cambio: 'creado', rolCodigo: 'operador_mantenimiento' },
      });

      await login('nuevo').expect(200); // el usuario creado entra con su clave
    });

    it('rechaza email o username repetidos (409), rol inexistente (400) y clave corta (400)', async () => {
      await crearUsuario('dup', 'operador');
      const base = { password: PASSWORD, name: 'X', roleId: roles['operador'], status: true };
      await http()
        .post('/api/users')
        .set(bearer(adminToken))
        .send({ ...base, email: email('dup'), username: `${tag}-otro` })
        .expect(409);
      await http()
        .post('/api/users')
        .set(bearer(adminToken))
        .send({ ...base, email: email('otro'), username: `${tag}-dup` })
        .expect(409);
      await http()
        .post('/api/users')
        .set(bearer(adminToken))
        .send({ ...base, email: email('r'), username: `${tag}-r`, roleId: uuidv7() })
        .expect(400);
      await http()
        .post('/api/users')
        .set(bearer(adminToken))
        .send({ ...base, email: email('c'), username: `${tag}-c`, password: 'corta' })
        .expect(400);
    });

    it('tipo_vinculo: por defecto empleado; contratista y externo pueden ir sin perfil o con él', async () => {
      const base = { password: PASSWORD, roleId: roles['operador'], status: true };
      const post = (n: string, extra: object = {}) =>
        http()
          .post('/api/users')
          .set(bearer(adminToken))
          .send({
            ...base,
            email: email(n),
            username: `${tag}-${n}`,
            name: `Persona ${n}`,
            ...extra,
          });

      // sin indicar el tipo: empleado
      const emp = (await post('tv-emp').expect(201)).body;
      expect(emp.tipoVinculo).toBe('empleado');

      // contratista sin perfil: no se crea fila en usuario_perfil y no salen campos de RRHH
      const con = (await post('tv-con', { tipoVinculo: 'contratista' }).expect(201)).body;
      expect(con.tipoVinculo).toBe('contratista');
      expect(con.cedula).toBeUndefined();
      const sinPerfil = await admin.query(
        'SELECT 1 FROM identidad.usuario_perfil WHERE usuario_id = $1',
        [con.id],
      );
      expect(sinPerfil.rowCount).toBe(0);

      // externo CON perfil: el tipo no impide guardar los datos que se necesiten
      const ext = (
        await post('tv-ext', {
          tipoVinculo: 'externo',
          cedula: '1799999999',
          cargo: 'Consultor externo',
        }).expect(201)
      ).body;
      expect(ext).toMatchObject({
        tipoVinculo: 'externo',
        cedula: '1799999999',
        cargo: 'Consultor externo',
      });

      // se puede cambiar después
      const upd = (
        await http()
          .put(`/api/users/${emp.id}`)
          .set(bearer(adminToken))
          .send({ tipoVinculo: 'contratista' })
          .expect(200)
      ).body;
      expect(upd.tipoVinculo).toBe('contratista');

      // valor fuera de la lista: rechazado por la API (400) ...
      await post('tv-mal', { tipoVinculo: 'visitante' }).expect(400);
      await http()
        .put(`/api/users/${emp.id}`)
        .set(bearer(adminToken))
        .send({ tipoVinculo: 'otro' })
        .expect(400);
      // ... y también por la propia base de datos, aunque alguien se salte la API
      await expect(
        admin.query(`UPDATE identidad.usuario SET tipo_vinculo = 'visitante' WHERE id = $1`, [
          emp.id,
        ]),
      ).rejects.toThrow(/invalid input value for enum .*tipo_vinculo/);
    });

    it('cambiar el rol o la clave cierra las sesiones abiertas del usuario', async () => {
      const u = await crearUsuario('cambio', 'operador');
      const t = (await login('cambio').expect(200)).body;
      const res = await http()
        .put(`/api/users/${u.id}`)
        .set(bearer(adminToken))
        .send({ roleId: roles['supervisor'], name: 'Renombrado' })
        .expect(200);
      expect(res.body).toMatchObject({ roleId: roles['supervisor'], name: 'Renombrado' });
      await http().post('/api/auth/refresh').send({ refreshToken: t.refreshToken }).expect(401);
      // el email no cambió y la clave tampoco: sigue pudiendo entrar con la misma
      expect((await login('cambio').expect(200)).body.user.roleCode).toBe('supervisor');
    });

    it('"borrar" desactiva la cuenta (no elimina datos) y no permite desactivarse a sí mismo', async () => {
      const u = await crearUsuario('borrar', 'operador');
      await http().delete(`/api/users/${u.id}`).set(bearer(adminToken)).expect(200, { ok: true });
      expect((await prisma.usuario.findUniqueOrThrow({ where: { id: u.id } })).activo).toBe(false);
      await login('borrar').expect(401);

      const adminId = (await prisma.usuario.findUniqueOrThrow({ where: { email: email('admin') } }))
        .id;
      await http().delete(`/api/users/${adminId}`).set(bearer(adminToken)).expect(400);
      await http().get(`/api/users/${uuidv7()}`).set(bearer(adminToken)).expect(404);
      await http().get('/api/users/no-es-uuid').set(bearer(adminToken)).expect(400);
    });

    it('roles: cualquier autenticado los lista; usuarios por rol solo trae id, nombre y especialidad', async () => {
      await http().get('/api/roles').expect(401);
      const roleList = (await http().get('/api/roles').set(bearer(adminToken)).expect(200)).body;
      expect(roleList).toHaveLength(16);
      expect(roleList[0]).toEqual(
        expect.objectContaining({
          id: expect.any(String),
          name: expect.any(String),
          code: expect.any(String),
        }),
      );

      const list = (
        await http().get('/api/roles/superadmin/usuarios').set(bearer(adminToken)).expect(200)
      ).body;
      expect(list.length).toBeGreaterThan(0);
      // legacyId es de transición: los módulos viejos asignan por ese id numérico
      for (const item of list) {
        expect(Object.keys(item).sort()).toEqual(['id', 'legacyId', 'name', 'specialty']);
      }
    });
  });

  describe('RBAC: permisos por rol', () => {
    let adminToken: string;
    let adminId: string;
    const P = ['qhse.iperc.aprobar', 'inventario.articulos.ver', 'comercial.pedidos.ver'];

    const put = (rolId: string, permisos: unknown, token = adminToken) =>
      http().put(`/api/roles/${rolId}/permisos`).set(bearer(token)).send({ permisos });
    const codigosEnBase = async (rolId: string) =>
      (
        await admin.query<{ codigo: string }>(
          `SELECT p.codigo FROM identidad.rol_permiso rp JOIN identidad.permiso p ON p.id = rp.permiso_id WHERE rp.rol_id = $1 ORDER BY 1`,
          [rolId],
        )
      ).rows.map((r) => r.codigo);

    beforeAll(async () => {
      rolPrueba = await prisma.rol.create({
        data: { id: uuidv7(), codigo: `${tag}-rbac`, nombre: 'Rol de prueba RBAC' },
      });
      roles['rbac-prueba'] = rolPrueba.id;
      adminId = (await crearUsuario('rbac-admin', 'superadmin')).id;
      adminToken = (await login('rbac-admin').expect(200)).body.accessToken;
    });

    it('el token y la sesión llevan los permisos vigentes del rol, y /me coincide', async () => {
      const esperados = await codigosEnBase(roles['jefe_mantenimiento']);
      expect(esperados.length).toBeGreaterThan(0);
      await crearUsuario('rbac-jm', 'jefe_mantenimiento');
      const res = (await login('rbac-jm').expect(200)).body;
      expect(res.user.permissions).toEqual(esperados);
      expect((jwt.decode(res.accessToken) as { permissions: string[] }).permissions).toEqual(
        esperados,
      );
      const me = (await http().get('/api/auth/me').set(bearer(res.accessToken)).expect(200)).body;
      expect(me.permissions).toEqual(esperados);
    });

    it('la siembra reprodujo la matriz de la demo (administradores y IPERC)', async () => {
      const sa = await codigosEnBase(roles['superadmin']);
      expect(sa).toEqual(
        expect.arrayContaining([
          'identidad.roles.ver',
          'identidad.roles.editar_permisos',
          'identidad.usuarios.ver',
          'identidad.usuarios.crear',
          'identidad.usuarios.editar',
          'identidad.usuarios.inactivar',
        ]),
      );
      const jefe = await codigosEnBase(roles['jefe_base']);
      expect(jefe).not.toContain('identidad.roles.ver');
      expect(jefe).not.toContain('identidad.usuarios.ver'); // como en la demo: ni Jefe de Base
      expect(jefe).not.toContain('qhse.iperc.aprobar'); // ipercApprove excluía a los administradores
      expect(await codigosEnBase(roles['gerente_hse'])).toContain('qhse.iperc.aprobar');
      expect(await codigosEnBase(roles['tecnico_hse'])).not.toContain('qhse.iperc.aprobar');
    });

    it('solo quien tiene identidad.roles.ver ve los permisos (y roles.editar_permisos los edita)', async () => {
      await crearUsuario('rbac-jefe', 'jefe_base');
      const jefe = (await login('rbac-jefe').expect(200)).body.accessToken;
      await http().get('/api/permissions').expect(401);
      await http().get('/api/permissions').set(bearer(jefe)).expect(403);
      await http().get(`/api/roles/${roles['operador']}/permisos`).set(bearer(jefe)).expect(403);
      await put(roles['operador'], [], jefe).expect(403);
      await http()
        .get(`/api/roles/${roles['operador']}/permisos/historial`)
        .set(bearer(jefe))
        .expect(403);
    });

    it('GET /permissions devuelve el catálogo completo, ordenado por módulo', async () => {
      const lista = (await http().get('/api/permissions').set(bearer(adminToken)).expect(200)).body;
      // El tamaño sale del catálogo: varios módulos agregan permisos a la vez y un número fijo se rompería a cada alta.
      expect(lista).toHaveLength(ALL_PERMISSION_CODES.length);
      expect(lista[0]).toEqual({
        id: expect.any(String),
        codigo: expect.stringMatching(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/),
        modulo: expect.any(String),
        recurso: expect.any(String),
        accion: expect.any(String),
        descripcion: expect.any(String),
      });
      const modulos = lista.map((p: { modulo: string }) => p.modulo);
      expect([...modulos]).toEqual([...modulos].sort());
    });

    it('GET /roles/:id/permisos: lista del rol, 404 si no existe y 400 si el id no es UUID', async () => {
      const vacio = await http()
        .get(`/api/roles/${rolPrueba!.id}/permisos`)
        .set(bearer(adminToken));
      expect(vacio.status).toBe(200);
      expect(vacio.body).toEqual([]);
      await http().get(`/api/roles/${uuidv7()}/permisos`).set(bearer(adminToken)).expect(404);
      await http().get('/api/roles/no-es-uuid/permisos').set(bearer(adminToken)).expect(400);
    });

    it('PUT reemplaza el conjunto y escribe solo la diferencia, con historial y evento', async () => {
      const rolId = rolPrueba!.id;
      const ordenados = [...P].sort();
      const r1 = (await put(rolId, P).expect(200)).body;
      expect(r1).toEqual({
        roleId: rolId,
        permisos: ordenados,
        otorgados: ordenados,
        revocados: [],
      });
      expect(await codigosEnBase(rolId)).toEqual(ordenados);

      const asign = await admin.query(
        `SELECT DISTINCT asignado_por FROM identidad.rol_permiso WHERE rol_id = $1`,
        [rolId],
      );
      expect(asign.rows).toEqual([{ asignado_por: adminId }]);
      const hist = await admin.query(
        `SELECT accion, realizado_por FROM identidad.rol_permiso_historial WHERE rol_id = $1`,
        [rolId],
      );
      expect(hist.rowCount).toBe(3);
      expect(hist.rows.every((h) => h.accion === 'otorgado' && h.realizado_por === adminId)).toBe(
        true,
      );
      const ev = await admin.query(
        `SELECT datos FROM msg_plataforma.outbox WHERE datos->'subject'->>'id' = $1`,
        [rolId],
      );
      expect(ev.rowCount).toBe(1);
      expect(ev.rows[0].datos).toMatchObject({
        type: 'plataforma.rol.actualizado',
        data: { rolId, rolCodigo: rolPrueba!.codigo, otorgados: ordenados, revocados: [] },
      });

      // mismo conjunto otra vez: nada cambia, nada se escribe
      const r2 = (await put(rolId, [...P].reverse()).expect(200)).body;
      expect(r2).toMatchObject({ otorgados: [], revocados: [] });
      const h2 = await admin.query(
        `SELECT 1 FROM identidad.rol_permiso_historial WHERE rol_id = $1`,
        [rolId],
      );
      expect(h2.rowCount).toBe(3);
      const e2 = await admin.query(
        `SELECT 1 FROM msg_plataforma.outbox WHERE datos->'subject'->>'id' = $1`,
        [rolId],
      );
      expect(e2.rowCount).toBe(1);

      // quita uno y agrega otro
      const r3 = (await put(rolId, [P[0], P[1], 'fcr.tickets.ver']).expect(200)).body;
      expect(r3).toMatchObject({ otorgados: ['fcr.tickets.ver'], revocados: [P[2]] });
      expect(await codigosEnBase(rolId)).toEqual([P[0], P[1], 'fcr.tickets.ver'].sort());

      // vaciar el rol también es válido
      const r4 = (await put(rolId, []).expect(200)).body;
      expect(r4.permisos).toEqual([]);
      expect(await codigosEnBase(rolId)).toEqual([]);
    });

    it('rechaza códigos inexistentes, con formato malo o campos extra, sin escribir nada', async () => {
      const rolId = rolPrueba!.id;
      const antes = await codigosEnBase(rolId);
      const r = await put(rolId, ['fcr.tickets.ver', 'no.existe.nada']).expect(400);
      expect(JSON.stringify(r.body.message)).toContain('no.existe.nada');
      await put(rolId, ['MAL FORMATO']).expect(400);
      await put(rolId, 'no-es-un-arreglo').expect(400);
      await http()
        .put(`/api/roles/${rolId}/permisos`)
        .set(bearer(adminToken))
        .send({ permisos: [], extra: 1 })
        .expect(400);
      await put(uuidv7(), []).expect(404);
      expect(await codigosEnBase(rolId)).toEqual(antes);
    });

    it('no deja a Superadmin sin poder administrar usuarios ni roles (evita quedarse sin administrador)', async () => {
      const antes = await codigosEnBase(roles['superadmin']);
      const protegidos = [
        'identidad.roles.ver',
        'identidad.roles.editar_permisos',
        'identidad.usuarios.ver',
        'identidad.usuarios.editar',
      ];
      const sinProtegidos = antes.filter((c) => !protegidos.includes(c));
      const r = await put(roles['superadmin'], sinProtegidos).expect(400);
      expect(JSON.stringify(r.body.message)).toMatch(/identidad\.roles\.ver/);
      await put(
        roles['superadmin'],
        antes.filter((c) => c !== 'identidad.usuarios.editar'),
      ).expect(400);
      expect(await codigosEnBase(roles['superadmin'])).toEqual(antes); // intacto
    });

    it('un cambio llega al usuario del rol en su próxima renovación, y el permiso manda sobre el nombre del rol', async () => {
      const rolId = rolPrueba!.id;
      await put(rolId, ['identidad.usuarios.ver']).expect(200);
      await crearUsuario('rbac-op', 'rbac-prueba');
      const sesion = (await login('rbac-op').expect(200)).body;
      expect(sesion.user.permissions).toEqual(['identidad.usuarios.ver']);

      // con el permiso entra a /users aunque su rol no sea Superadmin
      await http().get('/api/users').set(bearer(sesion.accessToken)).expect(200);
      // no tiene el de roles
      await http().get('/api/permissions').set(bearer(sesion.accessToken)).expect(403);

      // el administrador le quita el permiso: el token YA emitido sigue valiendo hasta renovar...
      await put(rolId, []).expect(200);
      await http().get('/api/users').set(bearer(sesion.accessToken)).expect(200);
      // ...pero al renovar la sesión recibe los permisos nuevos y pierde el acceso
      const renovada = (
        await http()
          .post('/api/auth/refresh')
          .send({ refreshToken: sesion.refreshToken })
          .expect(200)
      ).body;
      expect(renovada.user.permissions).toEqual([]);
      await http().get('/api/users').set(bearer(renovada.accessToken)).expect(403);
    });

    it('GET historial: lo más reciente primero, con quién lo hizo; el límite se valida', async () => {
      const rolId = rolPrueba!.id;
      const h = (
        await http()
          .get(`/api/roles/${rolId}/permisos/historial`)
          .set(bearer(adminToken))
          .expect(200)
      ).body;
      expect(h.length).toBeGreaterThanOrEqual(6);
      expect(h[0]).toEqual({
        id: expect.any(String),
        permiso: expect.any(String),
        accion: expect.stringMatching(/^(otorgado|revocado)$/),
        realizadoPor: { id: adminId, name: expect.stringContaining('rbac-admin') },
        realizadoAt: expect.stringMatching(/Z$/),
      });
      const fechas = h.map((x: { realizadoAt: string }) => x.realizadoAt);
      expect([...fechas]).toEqual([...fechas].sort().reverse());
      const dos = (
        await http()
          .get(`/api/roles/${rolId}/permisos/historial?limite=2`)
          .set(bearer(adminToken))
          .expect(200)
      ).body;
      expect(dos).toHaveLength(2);
      await http()
        .get(`/api/roles/${rolId}/permisos/historial?limite=0`)
        .set(bearer(adminToken))
        .expect(400);
      await http()
        .get(`/api/roles/${rolId}/permisos/historial?limite=9999`)
        .set(bearer(adminToken))
        .expect(400);
    });

    it('la bitácora es inmutable incluso para la aplicación: no puede modificarla ni borrarla', async () => {
      const fila = await prisma.rolPermisoHistorial.findFirstOrThrow({
        where: { rolId: rolPrueba!.id },
      });
      await expect(
        prisma.rolPermisoHistorial.update({ where: { id: fila.id }, data: { accion: 'revocado' } }),
      ).rejects.toThrow();
      await expect(prisma.rolPermisoHistorial.delete({ where: { id: fila.id } })).rejects.toThrow();
      const sigue = await admin.query(
        'SELECT 1 FROM identidad.rol_permiso_historial WHERE id = $1',
        [fila.id],
      );
      expect(sigue.rowCount).toBe(1);
    });

    it('la base impide una acción de historial inválida aunque se salte la API', async () => {
      await expect(
        admin.query(
          `INSERT INTO identidad.rol_permiso_historial (id, rol_id, permiso_codigo, accion) VALUES ($1, $2, 'x.y.z', 'borrado')`,
          [uuidv7(), rolPrueba!.id],
        ),
      ).rejects.toThrow(/invalid input value for enum .*accion_permiso/);
    });

    describe('permisos granulares de usuarios (ver / crear / editar / inactivar)', () => {
      let actorId: string;
      /** Deja al rol de prueba con exactamente estos permisos y devuelve el token de una sesión nueva. */
      const tokenCon = async (permisos: string[]) => {
        await put(rolPrueba!.id, permisos).expect(200);
        return (await login('gran-actor').expect(200)).body.accessToken as string;
      };
      const nuevoUsuario = (n: string, extra: object = {}) => ({
        email: email(n),
        username: `${tag}-${n}`,
        password: PASSWORD,
        name: `Persona ${n}`,
        roleId: roles['operador'],
        status: true,
        ...extra,
      });

      beforeAll(async () => {
        actorId = (await crearUsuario('gran-actor', 'rbac-prueba')).id;
      });

      it('solo ver: lista y detalla, pero no crea, edita ni inactiva', async () => {
        const victima = await crearUsuario('gran-v1', 'operador');
        const t = await tokenCon(['identidad.usuarios.ver']);
        await http().get('/api/users').set(bearer(t)).expect(200);
        await http().get(`/api/users/${victima.id}`).set(bearer(t)).expect(200);
        await http().post('/api/users').set(bearer(t)).send(nuevoUsuario('gran-x1')).expect(403);
        await http().put(`/api/users/${victima.id}`).set(bearer(t)).send({ name: 'X' }).expect(403);
        await http().delete(`/api/users/${victima.id}`).set(bearer(t)).expect(403);
        expect((await prisma.usuario.findUniqueOrThrow({ where: { id: victima.id } })).activo).toBe(
          true,
        );
      });

      it('crear no implica ver, editar ni inactivar', async () => {
        const victima = await crearUsuario('gran-v2', 'operador');
        const t = await tokenCon(['identidad.usuarios.crear']);
        await http().get('/api/users').set(bearer(t)).expect(403); // sin ver no lista
        const creado = await http().post('/api/users').set(bearer(t)).send(nuevoUsuario('gran-c1'));
        expect(creado.status).toBe(201);
        expect(creado.body.email).toBe(email('gran-c1'));
        await http().put(`/api/users/${victima.id}`).set(bearer(t)).send({ name: 'X' }).expect(403);
        await http().delete(`/api/users/${victima.id}`).set(bearer(t)).expect(403);
      });

      it('editar cambia datos y reactiva, pero no inactiva: ni con DELETE ni con PUT status:false', async () => {
        const victima = await crearUsuario('gran-v3', 'operador');
        const t = await tokenCon(['identidad.usuarios.editar']);

        const ok = await http()
          .put(`/api/users/${victima.id}`)
          .set(bearer(t))
          .send({ name: 'Renombrada' });
        expect(ok.status).toBe(200);
        expect(ok.body.name).toBe('Renombrada');

        // el atajo: editar con status:false ES inactivar, y se rechaza diciendo qué permiso falta
        const atajo = await http()
          .put(`/api/users/${victima.id}`)
          .set(bearer(t))
          .send({ status: false });
        expect(atajo.status).toBe(403);
        expect(JSON.stringify(atajo.body.message)).toContain('identidad.usuarios.inactivar');
        await http().delete(`/api/users/${victima.id}`).set(bearer(t)).expect(403);
        expect((await prisma.usuario.findUniqueOrThrow({ where: { id: victima.id } })).activo).toBe(
          true,
        );

        // reactivar una cuenta inactiva solo exige editar
        await admin.query('UPDATE identidad.usuario SET activo = false WHERE id = $1', [
          victima.id,
        ]);
        const reactivada = await http()
          .put(`/api/users/${victima.id}`)
          .set(bearer(t))
          .send({ status: true });
        expect(reactivada.status).toBe(200);
        expect(reactivada.body.status).toBe(true);
      });

      it('inactivar: DELETE inactiva y cierra sesiones; PUT status:false funciona si además tiene editar', async () => {
        const v1 = await crearUsuario('gran-v4', 'operador');
        const sesionVictima = (await login('gran-v4').expect(200)).body;
        const soloInactivar = await tokenCon(['identidad.usuarios.inactivar']);
        await http()
          .delete(`/api/users/${v1.id}`)
          .set(bearer(soloInactivar))
          .expect(200, { ok: true });
        expect((await prisma.usuario.findUniqueOrThrow({ where: { id: v1.id } })).activo).toBe(
          false,
        );
        // la sesión de la persona inactivada ya no se puede renovar
        await http()
          .post('/api/auth/refresh')
          .send({ refreshToken: sesionVictima.refreshToken })
          .expect(401);
        // inactivar sin editar tampoco permite editar datos
        await http()
          .put(`/api/users/${v1.id}`)
          .set(bearer(soloInactivar))
          .send({ name: 'X' })
          .expect(403);

        const v2 = await crearUsuario('gran-v5', 'operador');
        const ambos = await tokenCon(['identidad.usuarios.editar', 'identidad.usuarios.inactivar']);
        const res = await http()
          .put(`/api/users/${v2.id}`)
          .set(bearer(ambos))
          .send({ status: false });
        expect(res.status).toBe(200);
        expect(res.body.status).toBe(false);
      });

      it('nadie puede inactivar su propia cuenta, ni siquiera con el permiso', async () => {
        const t = await tokenCon(['identidad.usuarios.inactivar']);
        await http().delete(`/api/users/${actorId}`).set(bearer(t)).expect(400);
      });
    });

    describe('sincronización del catálogo de permisos', () => {
      const viejo = 'zzprueba.recurso.viejo';
      const defNuevo: PermissionDef = {
        code: 'zzprueba.recurso.nuevo',
        modulo: 'zzprueba',
        recurso: 'recurso',
        accion: 'nuevo',
        descripcion: 'Permiso nuevo de prueba',
        matrixKey: null,
        defaultRoles: [],
      };
      const crearViejoAsignado = async (rolId: string) => {
        const p = await prisma.permiso.create({
          data: {
            id: uuidv7(),
            codigo: viejo,
            modulo: 'zzprueba',
            recurso: 'recurso',
            accion: 'viejo',
            descripcion: 'Permiso viejo de prueba',
          },
        });
        await prisma.rolPermiso.create({ data: { rolId, permisoId: p.id } });
      };

      afterAll(async () => {
        const codigos = [viejo, defNuevo.code];
        await prisma.rolPermiso.deleteMany({ where: { permiso: { codigo: { in: codigos } } } });
        await prisma.permiso.deleteMany({ where: { codigo: { in: codigos } } });
      });

      it('traspasa las asignaciones del permiso retirado a sus reemplazos, deja historial y es idempotente', async () => {
        const rolId = rolPrueba!.id;
        await prisma.rolPermiso.deleteMany({ where: { rolId } });
        await crearViejoAsignado(rolId);
        const opts = {
          catalog: [defNuevo],
          replacements: [{ retired: viejo, replacedBy: [defNuevo.code] }],
        };

        expect(await syncPermisos(prisma, opts)).toEqual({
          nuevos: 1,
          asignacionesPorDefecto: 0,
          traspasadas: 1,
          retirados: 1,
        });
        // el rol conserva el acceso (ahora con el permiso nuevo) y el viejo ya no existe
        expect(await codigosEnBase(rolId)).toEqual([defNuevo.code]);
        expect(await prisma.permiso.findUnique({ where: { codigo: viejo } })).toBeNull();

        const h = await admin.query(
          `SELECT permiso_codigo, accion FROM identidad.rol_permiso_historial
            WHERE rol_id = $1 AND permiso_codigo = ANY($2) ORDER BY permiso_codigo`,
          [rolId, [viejo, defNuevo.code]],
        );
        expect(h.rows).toEqual([
          { permiso_codigo: defNuevo.code, accion: 'otorgado' },
          { permiso_codigo: viejo, accion: 'revocado' },
        ]);

        // una segunda corrida no cambia nada
        expect(await syncPermisos(prisma, opts)).toEqual({
          nuevos: 0,
          asignacionesPorDefecto: 0,
          traspasadas: 0,
          retirados: 0,
        });
      });

      it('si un reemplazo no existe, falla y deja el permiso viejo y sus asignaciones intactos', async () => {
        const rolId = rolPrueba!.id;
        await prisma.rolPermiso.deleteMany({ where: { rolId } });
        await crearViejoAsignado(rolId);
        await expect(
          syncPermisos(prisma, {
            catalog: [],
            replacements: [{ retired: viejo, replacedBy: ['zzprueba.no.existe'] }],
          }),
        ).rejects.toThrow(/no existen en el catálogo/);
        expect(await prisma.permiso.findUnique({ where: { codigo: viejo } })).not.toBeNull();
        expect(await codigosEnBase(rolId)).toContain(viejo);
      });

      it('volver a sembrar NO revierte lo que un administrador editó (solo asigna por defecto a permisos nuevos)', async () => {
        const rolId = roles['jefe_mantenimiento'];
        const originales = await codigosEnBase(rolId);
        const quitado = originales[0];
        try {
          await put(
            rolId,
            originales.filter((c) => c !== quitado),
          ).expect(200);
          await syncPermisos(prisma); // catálogo real
          expect(await codigosEnBase(rolId)).not.toContain(quitado); // sigue quitado
        } finally {
          await put(rolId, originales).expect(200); // se restaura el rol real
        }
        expect(await codigosEnBase(rolId)).toEqual(originales);
      });
    });
  });
});
