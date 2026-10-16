/**
 * Integración de la copia local de AS2: Postgres real (PgBouncer, app_plataforma) y un AS2 simulado.
 *   npm run infra:up && npm run db:migrate:identidad && npm run db:seed:identidad
 *   RUN_INTEGRATION=1 npx nx test identidad
 * Los empleados de prueba usan ids de AS2 >= 9.000.000 y se eliminan al final con dyn_migrator. Cada corrida
 * devuelve también los empleados reales ya copiados, para no disparar la protección de respuesta incompleta
 * ni alterar datos reales.
 */
import { INestApplication, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { generateKeyPairSync } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
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
import { CommonModule, configureApp } from '@dyn/common';
import { MessagingModule } from '@dyn/messaging';
import { uuidv7 } from '@dyn/utils';
import { IdentidadModule, identidadEnvSchema } from './index';
import { As2Empleado, As2Port, As2Usuario } from './as2/as2.port';
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
const tag = `it-as2-${Date.now()}`;
const ID0 = 9_000_000;

/** AS2 simulado: lo que devuelve se cambia en cada prueba. */
class As2Falso extends As2Port {
  empleados: As2Empleado[] = [];
  usuarios: As2Usuario[] = [];
  falla?: Error;
  async disponible() {
    return true;
  }
  async listarEmpleados() {
    if (this.falla) throw this.falla;
    return this.empleados;
  }
  async listarUsuarios() {
    return this.usuarios;
  }
}

const dia = (s: string) => new Date(`${s}T00:00:00.000Z`);

run('AS2: copia local de empleados (base de datos real)', () => {
  jest.setTimeout(60000);
  let app: INestApplication;
  let prisma: PrismaService;
  const as2 = new As2Falso();
  const admin = new Pool({ connectionString: MIGRATOR_DB, max: 2 });
  const http = () => request(app.getHttpServer());
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
  const ejecuciones: string[] = [];
  let tokenAdmin = '';
  let tokenOperador = '';

  const cedula = (n: number) => `IT${tag.slice(-8)}${n}`;
  const prueba = (n: number, extra: Partial<As2Empleado> = {}): As2Empleado => ({
    idEmpleado: ID0 + n,
    cedula: cedula(n),
    nombres: `NOMBRE${n}`,
    apellidos: `APELLIDO${n}`,
    genero: 'MASCULINO',
    cargo: 'OPERADOR CTU',
    departamento: 'OPERACIONES',
    sucursal: 'COCA',
    tipoContrato: 'POR OBRA',
    fechaIngreso: dia('2025-06-01'),
    fechaSalida: null,
    ...extra,
  });

  /** Empleados reales ya copiados (excluye los de prueba), tal como los devolvería AS2. */
  async function reales(): Promise<{ empleados: As2Empleado[]; usuarios: As2Usuario[] }> {
    const { rows } = await admin.query(
      `SELECT as2_empleado_id, cedula, nombres, apellidos, genero, cargo, departamento, sucursal,
              tipo_contrato, fecha_ingreso::text AS ingreso, fecha_salida::text AS salida, correo_as2
         FROM identidad.empleado_as2 WHERE as2_empleado_id < $1`,
      [ID0],
    );
    return {
      empleados: rows.map((r) => ({
        idEmpleado: r.as2_empleado_id,
        cedula: r.cedula,
        nombres: r.nombres,
        apellidos: r.apellidos,
        genero: r.genero,
        cargo: r.cargo,
        departamento: r.departamento,
        sucursal: r.sucursal,
        tipoContrato: r.tipo_contrato,
        fechaIngreso: r.ingreso ? dia(r.ingreso) : null,
        fechaSalida: r.salida ? dia(r.salida) : null,
      })),
      usuarios: rows
        .filter((r) => r.correo_as2)
        .map((r) => ({ identificacion: r.cedula, email: r.correo_as2 })),
    };
  }

  async function poner(pruebas: As2Empleado[], usuarios: As2Usuario[] = []) {
    const base = await reales();
    as2.empleados = [...base.empleados, ...pruebas];
    as2.usuarios = [...base.usuarios, ...usuarios];
    as2.falla = undefined;
  }

  const sincronizar = () => http().post('/api/as2/sincronizar').set(bearer(tokenAdmin));
  const fila = (n: number) =>
    admin
      .query(`SELECT * FROM identidad.empleado_as2 WHERE as2_empleado_id = $1`, [ID0 + n])
      .then((r) => r.rows[0]);
  const historial = (n: number) =>
    admin
      .query(
        `SELECT h.campo, h.valor_anterior, h.valor_nuevo
           FROM identidad.empleado_as2_historial h
           JOIN identidad.empleado_as2 e ON e.id = h.empleado_id
          WHERE e.as2_empleado_id = $1 ORDER BY h.campo`,
        [ID0 + n],
      )
      .then((r) => r.rows);

  async function usuarioConToken(n: string, rol: string): Promise<string> {
    const r = await prisma.rol.findUniqueOrThrow({ where: { codigo: rol } });
    await prisma.usuario.create({
      data: {
        id: uuidv7(),
        email: `${tag}-${n}@test.local`,
        username: `${tag}-${n}`,
        nombre: `Prueba ${n}`,
        rolId: r.id,
        passwordHash: await bcrypt.hash(PASSWORD, 4),
      },
    });
    const res = await http()
      .post('/api/auth/login')
      .send({ email: `${tag}-${n}@test.local`, password: PASSWORD })
      .expect(200);
    return res.body.accessToken;
  }

  beforeAll(async () => {
    Object.assign(process.env, {
      SERVICE_NAME: 'identidad-as2-test',
      PORT: '3197',
      LOG_LEVEL: 'silent',
      DATABASE_URL: APP_DB,
      RABBITMQ_URL: 'amqp://x:x@localhost:5672',
      JWT_PUBLIC_KEY: publicKey,
      JWT_PRIVATE_KEY: privateKey,
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
        CommonModule.forRoot({ serviceName: 'identidad-as2-test' }),
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

    const mod = await Test.createTestingModule({ imports: [TestAppModule] })
      .overrideProvider(As2Port)
      .useValue(as2)
      .compile();
    app = mod.createNestApplication();
    configureApp(app, { corsOrigins: ['http://localhost:4200'] });
    await app.init();
    prisma = app.get(PrismaService);
    tokenAdmin = await usuarioConToken('admin', 'superadmin');
    tokenOperador = await usuarioConToken('operador', 'operador');
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
    // las sincronizaciones que disparó cada cuenta apuntan a ella (FK): se quitan antes
    await admin.query(
      `DELETE FROM identidad.empleado_as2_historial WHERE ejecucion_id IN
         (SELECT id FROM identidad.sincronizacion_as2 WHERE disparada_por = ANY($1::uuid[]))`,
      [ids],
    );
    await admin.query(
      `DELETE FROM identidad.sincronizacion_as2 WHERE disparada_por = ANY($1::uuid[])`,
      [ids],
    );
    await admin.query(`DELETE FROM identidad.usuario WHERE id = ANY($1::uuid[])`, [ids]);
    await admin.query(
      `DELETE FROM identidad.empleado_as2_historial WHERE empleado_id IN
         (SELECT id FROM identidad.empleado_as2 WHERE as2_empleado_id >= $1)`,
      [ID0],
    );
    await admin.query(`DELETE FROM identidad.empleado_as2 WHERE as2_empleado_id >= $1`, [ID0]);
    await admin.query(
      `DELETE FROM identidad.empleado_as2_historial WHERE ejecucion_id = ANY($1::uuid[])`,
      [ejecuciones],
    );
    await admin.query(`DELETE FROM identidad.sincronizacion_as2 WHERE id = ANY($1::uuid[])`, [
      ejecuciones,
    ]);
    await admin.end();
    await app.close();
  });

  it('exige permiso: un operador no ve la copia ni sincroniza', async () => {
    await http().get('/api/as2/empleados').set(bearer(tokenOperador)).expect(403);
    await http().post('/api/as2/sincronizar').set(bearer(tokenOperador)).expect(403);
    await http().get('/api/as2/empleados').expect(401);
  });

  it('la primera corrida da de alta a los empleados y deja su historial', async () => {
    await poner(
      [prueba(1), prueba(2, { fechaSalida: dia('2021-01-15') }), prueba(3)],
      [{ identificacion: cedula(1), email: 'uno@dynadrill.com.ec' }],
    );
    const r = await sincronizar().expect(201);
    ejecuciones.push(r.body.id);
    expect(r.body).toMatchObject({ estado: 'ok', origen: 'manual', nuevos: 3, bajas: 0 });
    expect(r.body.leidos).toBe(as2.empleados.length);

    const e1 = await fila(1);
    expect(e1).toMatchObject({
      cargo: 'OPERADOR CTU',
      activo: true,
      correo_as2: 'uno@dynadrill.com.ec',
    });
    expect((await fila(2)).activo).toBe(false); // ya trae fecha de salida: entra como inactivo, no cuenta como baja
    expect((await historial(1)).map((h) => h.campo)).toEqual(
      expect.arrayContaining(['cargo', 'cedula', 'correoAs2', 'fechaIngreso']),
    );
    expect((await historial(1)).every((h) => h.valor_anterior === null)).toBe(true);
  });

  it('una segunda corrida sin cambios no genera historial', async () => {
    const antes = (await historial(1)).length;
    const r = await sincronizar().expect(201);
    ejecuciones.push(r.body.id);
    expect(r.body).toMatchObject({ estado: 'ok', nuevos: 0, modificados: 0, bajas: 0 });
    expect(await historial(1)).toHaveLength(antes);
  });

  it('un cambio de cargo y una fecha de salida quedan en el historial con su valor anterior', async () => {
    await poner(
      [
        prueba(1, { cargo: 'OPERADOR III CTU', fechaSalida: dia('2026-09-30') }),
        prueba(2, { fechaSalida: dia('2021-01-15') }),
        prueba(3),
      ],
      [{ identificacion: cedula(1), email: 'uno@dynadrill.com.ec' }],
    );
    const r = await sincronizar().expect(201);
    ejecuciones.push(r.body.id);
    expect(r.body).toMatchObject({ nuevos: 0, modificados: 1, bajas: 1 });
    expect(await fila(1)).toMatchObject({ cargo: 'OPERADOR III CTU', activo: false });

    const h = (await historial(1)).filter(
      (x) => x.valor_anterior !== null || x.campo === 'fechaSalida',
    );
    expect(h).toEqual(
      expect.arrayContaining([
        { campo: 'cargo', valor_anterior: 'OPERADOR CTU', valor_nuevo: 'OPERADOR III CTU' },
        { campo: 'fechaSalida', valor_anterior: null, valor_nuevo: '2026-09-30' },
        { campo: 'activo', valor_anterior: 'true', valor_nuevo: 'false' },
      ]),
    );

    const lista = await http()
      .get('/api/as2/empleados?activo=false&q=APELLIDO1')
      .set(bearer(tokenAdmin))
      .expect(200);
    expect(lista.body.items.map((e: { cedula: string }) => e.cedula)).toEqual([cedula(1)]);
    const id = (await fila(1)).id;
    const hist = await http()
      .get(`/api/as2/empleados/${id}/historial`)
      .set(bearer(tokenAdmin))
      .expect(200);
    expect(hist.body.length).toBeGreaterThanOrEqual(3);
  });

  it('si AS2 falla no se toca nada: queda el error registrado y la copia intacta', async () => {
    const antes = await fila(1);
    await poner([prueba(1, { cargo: 'OTRO CARGO' })]);
    as2.falla = new Error('AS2 respondió 500 en /rest/v2/catalogors/empleado');
    const r = await sincronizar().expect(502);
    expect(r.body.detail).toContain('No se pudo sincronizar con AS2');

    const despues = await fila(1);
    expect(despues.cargo).toBe(antes.cargo);
    expect(despues.sincronizado_at).toEqual(antes.sincronizado_at);
    const { rows } = await admin.query(
      `SELECT estado, error FROM identidad.sincronizacion_as2 ORDER BY iniciada_at DESC LIMIT 1`,
    );
    expect(rows[0].estado).toBe('error');
    expect(rows[0].error).toContain('500');
    ejecuciones.push(
      (
        await admin.query(
          `SELECT id FROM identidad.sincronizacion_as2 ORDER BY iniciada_at DESC LIMIT 1`,
        )
      ).rows[0].id,
    );
  });

  it('una respuesta vacía o muy incompleta se descarta y nadie se da de baja', async () => {
    as2.falla = undefined;
    as2.empleados = [];
    as2.usuarios = [];
    await sincronizar().expect(502);

    const base = await reales();
    // Solo 1 de todos los empleados que ya hay: menos de la mitad.
    as2.empleados = [prueba(1)];
    if (base.empleados.length + 3 > 2) {
      const r = await sincronizar().expect(502);
      expect(r.body.detail).toMatch(/incompleta|0 empleados/);
    }
    expect((await fila(3)).activo).toBe(true);
    for (const row of (
      await admin.query(
        `SELECT id FROM identidad.sincronizacion_as2 WHERE estado = 'error' AND iniciada_at > now() - interval '5 minutes'`,
      )
    ).rows) {
      ejecuciones.push(row.id);
    }
  });

  it('que un empleado falte en la respuesta no lo da de baja', async () => {
    await poner([
      prueba(1, { cargo: 'OPERADOR III CTU', fechaSalida: dia('2026-09-30') }),
      prueba(2, { fechaSalida: dia('2021-01-15') }),
    ]); // sin prueba(3)
    const r = await sincronizar().expect(201);
    ejecuciones.push(r.body.id);
    expect(r.body.bajas).toBe(0);
    expect((await fila(3)).activo).toBe(true);
    expect((await fila(3)).fecha_salida).toBeNull();
  });

  it('enlaza el perfil de un usuario con su empleado de AS2 por la cédula', async () => {
    const u = await prisma.usuario.create({
      data: {
        id: uuidv7(),
        email: `${tag}-perfil@test.local`,
        username: `${tag}-perfil`,
        nombre: 'Con perfil',
        rolId: (await prisma.rol.findUniqueOrThrow({ where: { codigo: 'operador' } })).id,
      },
    });
    const perfil = await prisma.usuarioPerfil.create({
      data: { id: uuidv7(), usuarioId: u.id, cedula: cedula(3) },
    });
    expect(perfil.empleadoAs2Id).toBeNull();

    await poner([
      prueba(1, { cargo: 'OPERADOR III CTU', fechaSalida: dia('2026-09-30') }),
      prueba(2, { fechaSalida: dia('2021-01-15') }),
      prueba(3),
    ]);
    const r = await sincronizar().expect(201);
    ejecuciones.push(r.body.id);

    const enlazado = await prisma.usuarioPerfil.findUniqueOrThrow({ where: { id: perfil.id } });
    expect(enlazado.empleadoAs2Id).toBe((await fila(3)).id);
    const lista = await http()
      .get('/api/as2/empleados?q=APELLIDO3')
      .set(bearer(tokenAdmin))
      .expect(200);
    expect(lista.body.items[0].usuarioId).toBe(u.id);
  });

  it('AS2 es la fuente de verdad: el perfil enlazado toma los datos del empleado, sin tocar los que AS2 no tiene', async () => {
    const u = await prisma.usuario.create({
      data: {
        id: uuidv7(),
        email: `${tag}-fuente@test.local`,
        username: `${tag}-fuente`,
        nombre: 'Fuente de verdad',
        rolId: (await prisma.rol.findUniqueOrThrow({ where: { codigo: 'operador' } })).id,
      },
    });
    const perfil = await prisma.usuarioPerfil.create({
      data: {
        id: uuidv7(),
        usuarioId: u.id,
        cedula: cedula(6),
        cargo: 'CARGO VIEJO DE LA DEMO',
        departamento: 'DEPARTAMENTO VIEJO',
        area: 'Área propia del portal', // AS2 no la tiene: no se toca
      },
    });
    await poner([prueba(6, { cargo: 'SUPERVISOR DE OPERACIONES', departamento: 'OPERACIONES' })]);
    const r = await sincronizar().expect(201);
    ejecuciones.push(r.body.id);

    const igualado = await prisma.usuarioPerfil.findUniqueOrThrow({ where: { id: perfil.id } });
    expect(igualado).toMatchObject({
      cargo: 'SUPERVISOR DE OPERACIONES',
      departamento: 'OPERACIONES',
      empleadoActivo: true,
      area: 'Área propia del portal',
    });
    // si AS2 cambia el cargo, el perfil lo sigue en la siguiente sincronización
    await poner([prueba(6, { cargo: 'GERENTE DE OPERACIONES', departamento: 'OPERACIONES' })]);
    const r2 = await sincronizar().expect(201);
    ejecuciones.push(r2.body.id);
    expect((await prisma.usuarioPerfil.findUniqueOrThrow({ where: { id: perfil.id } })).cargo).toBe(
      'GERENTE DE OPERACIONES',
    );
  });

  describe('cuentas del portal desde AS2 y cambio de clave obligatorio', () => {
    const NUEVO = `${tag}-nuevo@test.local`;
    const DUP = `${tag}-dup@test.local`;
    const LIBRE = `${tag}-libre@test.local`;
    const OCUPADO = `${tag}-ocupado@test.local`;
    const CEDULAS = [20, 21, 22, 23, 24, 25, 26].map(cedula);
    const crear = (body: Record<string, unknown>) =>
      http()
        .post('/api/as2/crear-cuentas')
        .set(bearer(tokenAdmin))
        .send({ cedulas: CEDULAS, ...body });
    type Fila = { email: string; resultado: string };
    const porEmail = (detalle: Fila[], email: string) => detalle.find((d) => d.email === email);

    beforeAll(async () => {
      const rol = await prisma.rol.findUniqueOrThrow({ where: { codigo: 'operador' } });
      await prisma.usuario.create({
        data: {
          id: uuidv7(),
          email: LIBRE,
          username: `${tag}-libre`,
          nombre: 'Existente sin perfil',
          rolId: rol.id,
        },
      });
      const ocupado = await prisma.usuario.create({
        data: {
          id: uuidv7(),
          email: OCUPADO,
          username: `${tag}-ocupado`,
          nombre: 'Existente con perfil',
          rolId: rol.id,
        },
      });
      await prisma.usuarioPerfil.create({
        data: { id: uuidv7(), usuarioId: ocupado.id, cedula: `OTRA${tag.slice(-6)}` },
      });
      await poner(
        [
          prueba(20, { cargo: 'OPERADOR III CTU' }),
          prueba(21), // sin correo en AS2
          prueba(22),
          prueba(23), // mismo correo que el 22
          prueba(24), // correo de un usuario que ya existe y no tiene perfil
          prueba(25), // correo de un usuario que ya tiene otro perfil
          prueba(26, { fechaSalida: dia('2021-01-15') }), // ya salió: no recibe cuenta
        ],
        [
          { identificacion: cedula(20), email: NUEVO.toUpperCase() },
          { identificacion: cedula(22), email: DUP },
          { identificacion: cedula(23), email: DUP },
          { identificacion: cedula(24), email: LIBRE },
          { identificacion: cedula(25), email: OCUPADO },
          { identificacion: cedula(26), email: `${tag}-salio@test.local` },
        ],
      );
      const r = await sincronizar().expect(201);
      ejecuciones.push(r.body.id);
    });

    it('exige su propio permiso y por defecto solo simula', async () => {
      await http().post('/api/as2/crear-cuentas').set(bearer(tokenOperador)).send({}).expect(403);
      const r = await crear({}).expect(201); // sin "simular": es simulación
      expect(r.body).toMatchObject({ simulacion: true, creadas: 0, vinculadas: 0 });
      expect(await prisma.usuario.findUnique({ where: { email: NUEVO.toLowerCase() } })).toBeNull();
    });

    it('la vista previa clasifica a cada empleado y los que no tienen correo no cuentan', async () => {
      const r = (await crear({ simular: true }).expect(201)).body;
      expect(r.empleadosActivos).toBe(6); // el 26 ya salió
      expect(r.sinCorreo).toBe(1); // el 21: sin correo no se crea cuenta
      expect(porEmail(r.detalle, NUEVO.toLowerCase())).toMatchObject({
        resultado: 'crear',
        rolSugerido: 'operador',
        rolReconocido: true,
      });
      expect(porEmail(r.detalle, LIBRE)).toMatchObject({ resultado: 'vincular' });
      expect(porEmail(r.detalle, OCUPADO)).toMatchObject({ resultado: 'conflicto' });
      const dup = r.detalle.filter((d: Fila) => d.email === DUP);
      expect(dup).toHaveLength(2);
      expect(dup.every((d: Fila) => d.resultado === 'conflicto')).toBe(true);
      expect(r.detalle.some((d: Fila) => d.email.includes('salio'))).toBe(false);
      expect(r.conflictos).toBe(3);
    });

    it('crea la cuenta INACTIVA, con perfil enlazado, rol sugerido y cambio de clave pendiente', async () => {
      const r = (await crear({ simular: false }).expect(201)).body;
      expect(r).toMatchObject({ simulacion: false, creadas: 1, vinculadas: 1, conflictos: 3 });

      const u = await prisma.usuario.findUniqueOrThrow({
        where: { email: NUEVO.toLowerCase() },
        include: { perfil: true, rol: true },
      });
      expect(u).toMatchObject({ activo: false, debeCambiarClave: true, tipoVinculo: 'empleado' });
      expect(u.rol.codigo).toBe('operador');
      expect(u.passwordHash).toBeTruthy(); // clave aleatoria que nadie conoce
      expect(u.perfil).toMatchObject({
        cedula: cedula(20),
        cargo: 'OPERADOR III CTU',
        empleadoActivo: true,
      });
      expect(u.perfil?.empleadoAs2Id).toBe((await fila(20)).id);

      // el usuario que ya existía recibió el perfil, sin duplicarse
      const libre = await prisma.usuario.findUniqueOrThrow({
        where: { email: LIBRE },
        include: { perfil: true },
      });
      expect(libre.perfil?.cedula).toBe(cedula(24));

      // inactiva: no entra
      await http()
        .post('/api/auth/login')
        .send({ email: NUEVO.toLowerCase(), password: 'cualquiera-1234' })
        .expect(401);

      // los conflictos y el que no tiene correo no crearon nada
      expect(await prisma.usuario.count({ where: { email: DUP } })).toBe(0);
      const sinCorreo = await prisma.empleadoAs2.findFirstOrThrow({
        where: { as2EmpleadoId: ID0 + 21 },
        include: { perfiles: true },
      });
      expect(sinCorreo.perfiles).toHaveLength(0);

      // correr de nuevo no duplica
      const otra = (await crear({ simular: false }).expect(201)).body;
      expect(otra).toMatchObject({ creadas: 0, vinculadas: 0 });
    });

    it('flujo completo: el administrador activa la cuenta, la persona entra con las iniciales + 123* y debe cambiar la clave antes de usar el sistema', async () => {
      const u = await prisma.usuario.findUniqueOrThrow({ where: { email: NUEVO.toLowerCase() } });
      await http()
        .put(`/api/users/${u.id}`)
        .set(bearer(tokenAdmin))
        .send({ status: true })
        .expect(200);

      const entrar = (password: string, estado = 200) =>
        http()
          .post('/api/auth/login')
          .send({ email: NUEVO.toLowerCase(), password })
          .expect(estado);
      const login = (await entrar('NA123*')).body;
      expect(login.user.mustChangePassword).toBe(true);
      const conClaveProvisional = { Authorization: `Bearer ${login.accessToken}` };

      // con la clave provisional solo se puede cambiarla, ver quién es y cerrar sesión
      const bloqueado = await http().get('/api/users').set(conClaveProvisional).expect(403);
      expect(bloqueado.body.code).toBe('PASSWORD_CHANGE_REQUIRED');
      await http().get('/api/roles').set(conClaveProvisional).expect(403);
      const yo = await http().get('/api/auth/me').set(conClaveProvisional).expect(200);
      expect(yo.body.mustChangePassword).toBe(true);

      // validaciones del cambio
      const cambiar = (currentPassword: string, newPassword: string, estado: number) =>
        http()
          .post('/api/auth/change-password')
          .set(conClaveProvisional)
          .send({ currentPassword, newPassword })
          .expect(estado);
      await cambiar('incorrecta-123', 'Mi-clave-nueva-2026', 401);
      await cambiar('NA123*', 'NA123*', 400);
      await cambiar('NA123*', 'corta', 400);

      // cambio correcto: sesión nueva sin la marca, y la anterior queda revocada
      const cambio = (await cambiar('NA123*', 'Mi-clave-nueva-2026', 200)).body;
      expect(cambio.user.mustChangePassword).toBe(false);
      await http()
        .get('/api/roles')
        .set({ Authorization: `Bearer ${cambio.accessToken}` })
        .expect(200);
      await http().post('/api/auth/refresh').send({ refreshToken: login.refreshToken }).expect(401);

      // la clave provisional ya no sirve; la nueva sí, y la marca queda apagada en la base
      await entrar('NA123*', 401);
      expect((await entrar('Mi-clave-nueva-2026')).body.user.mustChangePassword).toBe(false);
      expect(
        (await prisma.usuario.findUniqueOrThrow({ where: { id: u.id } })).debeCambiarClave,
      ).toBe(false);
      // ruta alternativa: el administrador fija OTRA clave provisional y exige cambiarla
      await http()
        .put(`/api/users/${u.id}`)
        .set(bearer(tokenAdmin))
        .send({ password: 'Otra-provisional-1*', forceChangePassword: true })
        .expect(200);
      expect((await entrar('Otra-provisional-1*')).body.user.mustChangePassword).toBe(true);
    });
  });

  it('la bitácora de cambios es de solo inserción para la aplicación', async () => {
    await expect(
      prisma.empleadoAs2Historial.updateMany({ data: { campo: 'x' }, where: { campo: 'cargo' } }),
    ).rejects.toThrow();
  });
});
