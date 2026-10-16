/**
 * Integración real del motor: Postgres (PgBouncer, app_plataforma) y un tercero simulado en un servidor HTTP local.
 *   npm run infra:up && npm run db:migrate:integraciones
 *   RUN_INTEGRATION=1 npx nx test integraciones
 * Los proveedores de prueba se llaman `it_<n>` y se eliminan al final con dyn_migrator (la aplicación no tiene
 * DELETE). No toca el proveedor real `as2`.
 */
import { INestApplication, Module } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
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
import { IntegracionError, IntegracionesModule, MotorService } from './index';
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

const n = Date.now();
const COD = `it_${n}`;
const COD_XML = `it_xml_${n}`;
const ACTOR = uuidv7();
/** Cuentas reales: quién creó, modificó o subió cada registro es FK a `identidad.usuario`. */
const MAESTROS: MaestrosDePrueba = {
  usuarios: [{ id: ACTOR, nombre: 'Actor de prueba', rol: 'superadmin' }],
};
const SECRETO_USER = 'AS2_IT_USUARIO';
const SECRETO_CLAVE = 'AS2_IT_CLAVE';
const CLAVE = 'clave-secreta-de-prueba';

/** Tercero simulado: login por token, consulta paginada y modos de falla. */
class Tercero {
  server!: Server;
  url = '';
  logins = 0;
  llamadas = 0;
  tokenVigente = '';
  /** Respuestas 500 que quedan por dar antes de contestar bien. */
  fallas500 = 0;
  /** Hacer que el próximo uso del token sea rechazado (401). */
  expirarToken = false;
  readonly filas = Array.from({ length: 5 }, (_, i) => ({
    id: i + 1,
    persona: { documento: `D${i + 1}`, nombre: ` Nombre ${i + 1} ` },
    ingreso: 1748754000000,
    salida: i === 4 ? 1629262800000 : null,
  }));
  /** Cuerpos recibidos en las consultas (para verificar plantillas y paginación). */
  cuerpos: Array<Record<string, unknown>> = [];

  async iniciar() {
    this.server = createServer((req, res) => void this.atender(req, res));
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  async detener() {
    await new Promise((r) => this.server.close(r));
  }

  private async leer(req: IncomingMessage): Promise<Record<string, unknown>> {
    const trozos: Buffer[] = [];
    for await (const t of req) trozos.push(t as Buffer);
    const txt = Buffer.concat(trozos).toString();
    return txt ? JSON.parse(txt) : {};
  }

  private responder(res: ServerResponse, status: number, cuerpo: unknown) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(cuerpo));
  }

  private async atender(req: IncomingMessage, res: ServerResponse) {
    const cuerpo = await this.leer(req);
    if (req.url === '/api/login') {
      if (cuerpo['nombreUsuario'] !== 'usuario-it' || cuerpo['clave'] !== CLAVE) {
        return this.responder(res, 401, { mensaje: 'credenciales inválidas' });
      }
      this.logins++;
      this.tokenVigente = `tok-${this.logins}`;
      return this.responder(res, 200, { token: this.tokenVigente });
    }
    this.llamadas++;
    if (this.expirarToken) {
      this.expirarToken = false;
      return this.responder(res, 401, { mensaje: 'token vencido' });
    }
    if (req.headers.authorization !== `Bearer ${this.tokenVigente}`) {
      return this.responder(res, 401, { mensaje: 'sin sesión' });
    }
    if (this.fallas500 > 0) {
      this.fallas500--;
      return this.responder(res, 500, { mensaje: 'falla interna' });
    }
    if (req.url?.startsWith('/api/personas') || req.url?.startsWith('/api/v2/personas')) {
      this.cuerpos.push(cuerpo);
      const desde = Number(cuerpo['desde'] ?? cuerpo['primerResultado'] ?? 0);
      const tam = Number(cuerpo['cuantos'] ?? cuerpo['resultadoMaximo'] ?? 1000);
      return this.responder(res, 200, { datos: this.filas.slice(desde, desde + tam) });
    }
    if (req.url === '/api/rechazo') return this.responder(res, 403, { mensaje: 'prohibido' });
    return this.responder(res, 404, { mensaje: 'no existe' });
  }
}

run('integraciones (base de datos real)', () => {
  jest.setTimeout(60000);
  let app: INestApplication;
  let prisma: PrismaService;
  let motor: MotorService;
  const tercero = new Tercero();
  const admin = new Pool({ connectionString: MIGRATOR_DB, max: 2 });
  const http = () => request(app.getHttpServer());
  const signer = new JwtService({
    privateKey,
    signOptions: { algorithm: 'RS256', issuer: 'dynadrill-plataforma', expiresIn: 600 },
  });
  const token = (permissions: string[]) =>
    signer.sign({
      sub: ACTOR,
      email: 'it@test.local',
      roleId: 'r',
      roleCode: 'operador',
      permissions,
    });
  const P = Permission;
  const adm = () => ({
    Authorization: `Bearer ${token([P.INTEGRACIONES_VER, P.INTEGRACIONES_EDITAR, P.INTEGRACIONES_PROBAR])}`,
  });

  /** Mapeo de la operación de prueba: solo la forma de la respuesta del tercero simulado. */
  const MAPEOS = [
    { destino: 'id', origen: 'id', transformacion: 'entero', obligatorio: true },
    {
      destino: 'documento',
      origen: 'persona.documento',
      transformacion: 'texto',
      obligatorio: true,
    },
    { destino: 'nombre', origen: 'persona.nombre', transformacion: 'texto' },
    { destino: 'ingreso', origen: 'ingreso', transformacion: 'fecha_ms_ec' },
    { destino: 'salida', origen: 'salida', transformacion: 'fecha_ms_ec' },
  ];
  const versionBase = {
    metodo: 'POST',
    ruta: '/api/personas',
    cuerpo: { filtro: { org: '{{var.org}}' } },
    paginacion: {
      tipo: 'offset',
      tamano: 2,
      inicio: 0,
      campoDesde: 'desde',
      campoTamano: 'cuantos',
    },
    rutaResultados: 'datos',
    mapeos: MAPEOS,
  };

  beforeAll(async () => {
    await sembrarMaestros(admin, MAESTROS);
    process.env[SECRETO_USER] = 'usuario-it';
    process.env[SECRETO_CLAVE] = CLAVE;
    await tercero.iniciar();
    Object.assign(process.env, {
      SERVICE_NAME: 'integraciones-test',
      PORT: '3196',
      LOG_LEVEL: 'silent',
      DATABASE_URL: APP_DB,
      JWT_PUBLIC_KEY: publicKey,
    });
    const envSchema = defineEnv(baseEnvSchema, databaseEnvSchema, jwtVerifyEnvSchema);

    @Module({
      imports: [
        AppConfigModule.forRoot(envSchema),
        CommonModule.forRoot({ serviceName: 'integraciones-test' }),
        IntegracionesModule,
      ],
    })
    class TestAppModule {}

    const mod = await Test.createTestingModule({ imports: [TestAppModule] }).compile();
    app = mod.createNestApplication();
    configureApp(app, { corsOrigins: ['http://localhost:4200'] });
    await app.init();
    prisma = app.get(PrismaService);
    motor = app.get(MotorService);

    // Proveedor de prueba con login por token y una operación v1 (se crea por la API, como lo haría un administrador).
    const proveedorId = uuidv7();
    await prisma.proveedor.create({
      data: {
        id: proveedorId,
        codigo: COD,
        nombre: 'Tercero de prueba',
        baseUrl: tercero.url,
        ambiente: 'pruebas',
        reintentos: 1,
        timeoutMs: 5000,
        variables: { org: 7 },
      },
    });
    await prisma.autenticacion.create({
      data: {
        id: uuidv7(),
        proveedorId,
        tipo: 'bearer_login',
        config: { operacion: 'login', campoToken: 'token', vidaSegundos: 600 },
        secretos: { usuario: SECRETO_USER, clave: SECRETO_CLAVE },
      },
    });
    const login = await prisma.operacion.create({
      data: {
        id: uuidv7(),
        proveedorId,
        codigo: 'login',
        activa: true,
        ruta: '/api/login',
        cuerpo: { nombreUsuario: '{{secreto.usuario}}', clave: '{{secreto.clave}}' },
        requiereAuth: false,
      },
    });
    expect(login.activa).toBe(true);
    const v1 = await http()
      .post(`/api/integraciones/proveedores/${COD}/operaciones/listar_personas/versiones`)
      .set(adm())
      .send(versionBase)
      .expect(201);
    await http()
      .post(`/api/integraciones/operaciones/${v1.body.id}/activar`)
      .set(adm())
      .expect(201);
  });

  afterAll(async () => {
    await admin.query(
      `DELETE FROM integraciones.ejecucion WHERE operacion_id IN
         (SELECT o.id FROM integraciones.operacion o JOIN integraciones.proveedor p ON p.id = o.proveedor_id WHERE p.codigo LIKE 'it\\_%')`,
    );
    await admin.query(
      `DELETE FROM integraciones.cambio WHERE entidad_id IN
         (SELECT o.id FROM integraciones.operacion o JOIN integraciones.proveedor p ON p.id = o.proveedor_id WHERE p.codigo LIKE 'it\\_%'
          UNION SELECT id FROM integraciones.proveedor WHERE codigo LIKE 'it\\_%')`,
    );
    await admin.query(
      `DELETE FROM integraciones.mapeo_campo WHERE operacion_id IN
         (SELECT o.id FROM integraciones.operacion o JOIN integraciones.proveedor p ON p.id = o.proveedor_id WHERE p.codigo LIKE 'it\\_%')`,
    );
    await admin.query(
      `DELETE FROM integraciones.operacion WHERE proveedor_id IN (SELECT id FROM integraciones.proveedor WHERE codigo LIKE 'it\\_%')`,
    );
    await admin.query(
      `DELETE FROM integraciones.autenticacion WHERE proveedor_id IN (SELECT id FROM integraciones.proveedor WHERE codigo LIKE 'it\\_%')`,
    );
    await admin.query(`DELETE FROM integraciones.proveedor WHERE codigo LIKE 'it\\_%'`);
    await quitarMaestros(admin, MAESTROS);
    await admin.end();
    await app.close();
    await tercero.detener();
    delete process.env[SECRETO_USER];
    delete process.env[SECRETO_CLAVE];
  });

  it('ejecuta la operación: inicia sesión, pagina, traduce los campos y omite filas incompletas', async () => {
    tercero.cuerpos = [];
    const r = await motor.ejecutar(COD, 'listar_personas');

    expect(r.leidos).toBe(5);
    expect(r.omitidos).toBe(0);
    expect(r.registros).toHaveLength(5);
    expect(r.registros[0]).toEqual({
      id: 1,
      documento: 'D1',
      nombre: 'Nombre 1', // recortado
      ingreso: new Date('2025-06-01T00:00:00.000Z'), // medianoche de Ecuador → día de calendario
      salida: null,
    });
    expect(r.registros[4]['salida']).toEqual(new Date('2021-08-18T00:00:00.000Z'));

    // 3 páginas de 2: [2, 2, 1]; la plantilla del cuerpo y los campos de paginación llegaron al tercero
    expect(tercero.cuerpos.map((c) => [c['desde'], c['cuantos']])).toEqual([
      [0, 2],
      [2, 2],
      [4, 2],
    ]);
    expect(tercero.cuerpos[0]['filtro']).toEqual({ org: 7 }); // {{var.org}} conserva el número
  });

  it('reutiliza el token: dos ejecuciones seguidas, un solo login', async () => {
    const antes = tercero.logins;
    await motor.ejecutar(COD, 'listar_personas');
    await motor.ejecutar(COD, 'listar_personas');
    expect(tercero.logins - antes).toBeLessThanOrEqual(1);
  });

  it('si el tercero rechaza el token (401), vuelve a iniciar sesión una vez y sigue', async () => {
    const antes = tercero.logins;
    tercero.expirarToken = true;
    const r = await motor.ejecutar(COD, 'listar_personas');
    expect(r.registros).toHaveLength(5);
    expect(tercero.logins).toBe(antes + 1);
  });

  it('reintenta ante 500 y se recupera; si sigue fallando informa el error sin secretos', async () => {
    tercero.fallas500 = 1;
    expect((await motor.ejecutar(COD, 'listar_personas')).registros).toHaveLength(5);

    tercero.fallas500 = 5;
    const error = await motor.ejecutar(COD, 'listar_personas').catch((e: Error) => e);
    expect(error).toBeInstanceOf(IntegracionError);
    expect((error as IntegracionError).message).toContain('500');
    expect((error as IntegracionError).message).not.toContain(CLAVE);
    expect((error as IntegracionError).message).not.toMatch(/tok-/);
    tercero.fallas500 = 0;
  });

  it('un 403 provoca una sola renovación de sesión (no un bucle) y luego llega el mensaje del tercero', async () => {
    const v = await http()
      .post(`/api/integraciones/proveedores/${COD}/operaciones/rechazo/versiones`)
      .set(adm())
      .send({ metodo: 'POST', ruta: '/api/rechazo', cuerpo: {}, rutaResultados: '', mapeos: [] })
      .expect(201);
    await http().post(`/api/integraciones/operaciones/${v.body.id}/activar`).set(adm()).expect(201);
    const antes = tercero.llamadas;
    await expect(motor.ejecutar(COD, 'rechazo')).rejects.toThrow(/403.*prohibido/);
    expect(tercero.llamadas - antes).toBe(2); // la llamada y un único reintento tras renovar el token
  });

  it('deja bitácora de cada llamada, sin secretos ni datos', async () => {
    await motor.ejecutar(COD, 'listar_personas', { solicitadoPor: ACTOR });
    const { rows } = await admin.query(
      `SELECT e.estado, e.registros, e.solicitado_por, e.error
         FROM integraciones.ejecucion e
         JOIN integraciones.operacion o ON o.id = e.operacion_id
         JOIN integraciones.proveedor p ON p.id = o.proveedor_id
        WHERE p.codigo = $1 ORDER BY e.iniciada_at DESC`,
      [COD],
    );
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows[0]).toMatchObject({ estado: 'ok', registros: 5, solicitado_por: ACTOR });
    expect(rows.some((r) => r.estado === 'error')).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(CLAVE);
    // inmutable para la aplicación
    await expect(prisma.ejecucion.updateMany({ data: { estado: 'ok' } })).rejects.toThrow();
  });

  describe('gobierno desde la base de datos', () => {
    it('valida una versión antes de guardarla: marcadores y secretos desconocidos, destinos repetidos', async () => {
      const r = await http()
        .post(`/api/integraciones/proveedores/${COD}/operaciones/listar_personas/versiones`)
        .set(adm())
        .send({
          ...versionBase,
          cuerpo: { a: '{{raro.x}}', b: '{{secreto.inexistente}}' },
          mapeos: [...MAPEOS, MAPEOS[0]],
        })
        .expect(400);
      const msg = JSON.stringify(r.body.message);
      expect(msg).toContain('{{raro.x}}');
      expect(msg).toContain('inexistente');
      expect(msg).toContain('destinos repetidos');
    });

    it('una versión nueva no afecta a la activa hasta activarla; volver atrás es activar la anterior', async () => {
      const v2 = await http()
        .post(`/api/integraciones/proveedores/${COD}/operaciones/listar_personas/versiones`)
        .set(adm())
        .send({
          ...versionBase,
          ruta: '/api/v2/personas', // el tercero "cambió" su ruta
          mapeos: MAPEOS.filter((m) => m.destino !== 'nombre'), // y ya no usamos el nombre
        })
        .expect(201);
      expect(v2.body).toMatchObject({ version: 2, activa: false });

      // sigue funcionando la v1 (con nombre)
      expect((await motor.ejecutar(COD, 'listar_personas')).registros[0]).toHaveProperty('nombre');

      // se prueba la v2 sin activarla: solo conteos y nombres de campos, nunca los valores
      const prueba = await http()
        .post(`/api/integraciones/operaciones/${v2.body.id}/probar`)
        .set(adm())
        .send({})
        .expect(201);
      expect(prueba.body).toMatchObject({ leidos: 5, registros: 5, omitidos: 0 });
      expect(prueba.body.campos).toEqual(['id', 'documento', 'ingreso', 'salida']);
      expect(JSON.stringify(prueba.body)).not.toContain('Nombre 1');

      // se activa: el motor usa la v2 sin tocar código
      await http()
        .post(`/api/integraciones/operaciones/${v2.body.id}/activar`)
        .set(adm())
        .expect(201);
      expect((await motor.ejecutar(COD, 'listar_personas')).registros[0]).not.toHaveProperty(
        'nombre',
      );
      const activas = await admin.query(
        `SELECT version FROM integraciones.operacion o JOIN integraciones.proveedor p ON p.id = o.proveedor_id
          WHERE p.codigo = $1 AND o.codigo = 'listar_personas' AND o.activa`,
        [COD],
      );
      expect(activas.rows).toEqual([{ version: 2 }]); // una sola activa

      // se vuelve atrás: activar la v1
      const v1 = await prisma.operacion.findFirstOrThrow({
        where: { proveedor: { codigo: COD }, codigo: 'listar_personas', version: 1 },
      });
      await http().post(`/api/integraciones/operaciones/${v1.id}/activar`).set(adm()).expect(201);
      expect((await motor.ejecutar(COD, 'listar_personas')).registros[0]).toHaveProperty('nombre');

      // todo quedó registrado: quién, qué y cuándo
      const cambios = await http()
        .get(`/api/integraciones/cambios/${v2.body.id}`)
        .set(adm())
        .expect(200);
      expect(cambios.body.map((c: { accion: string }) => c.accion)).toEqual(
        expect.arrayContaining(['version_creada', 'activada']),
      );
      expect(cambios.body[0].realizadoPor).toBe(ACTOR);
    });

    it('un proveedor inactivo, o con un formato que el motor aún no habla, falla con un error claro', async () => {
      await http()
        .put(`/api/integraciones/proveedores/${COD}`)
        .set(adm())
        .send({ activo: false })
        .expect(200);
      await expect(motor.ejecutar(COD, 'listar_personas')).rejects.toThrow(/no está disponible/);
      expect(await motor.disponible(COD)).toBe(false);
      await http()
        .put(`/api/integraciones/proveedores/${COD}`)
        .set(adm())
        .send({ activo: true })
        .expect(200);
      expect(await motor.disponible(COD)).toBe(true);

      await prisma.proveedor.create({
        data: {
          id: uuidv7(),
          codigo: COD_XML,
          nombre: 'Otro',
          baseUrl: tercero.url,
          ambiente: 'pruebas',
          formato: 'xml',
        },
      });
      const p = await prisma.proveedor.findUniqueOrThrow({ where: { codigo: COD_XML } });
      await prisma.operacion.create({
        data: {
          id: uuidv7(),
          proveedorId: p.id,
          codigo: 'x',
          activa: true,
          ruta: '/x',
          requiereAuth: false,
        },
      });
      await expect(motor.ejecutar(COD_XML, 'x')).rejects.toThrow(
        /formato "xml".*no está soportado/,
      );
    });

    it('la configuración visible nunca trae valores de secretos, solo sus nombres', async () => {
      const r = await http().get(`/api/integraciones/proveedores/${COD}`).set(adm()).expect(200);
      expect(r.body.autenticacion.secretos.sort()).toEqual(['clave', 'usuario']);
      expect(JSON.stringify(r.body)).not.toContain(CLAVE);
      expect(JSON.stringify(r.body)).not.toContain('usuario-it');
      const lista = await http().get('/api/integraciones/proveedores').set(adm()).expect(200);
      expect(JSON.stringify(lista.body)).not.toContain(CLAVE);
    });

    it('un secreto fuera de los prefijos permitidos no se entrega, aunque la configuración lo pida', async () => {
      const p = await prisma.proveedor.findUniqueOrThrow({ where: { codigo: COD } });
      const aut = await prisma.autenticacion.findUniqueOrThrow({ where: { proveedorId: p.id } });
      // se redirige el secreto "clave" a una variable que NO tiene prefijo permitido
      await admin.query(
        `UPDATE integraciones.autenticacion SET secretos = jsonb_set(secretos, '{clave}', '"DATABASE_URL"') WHERE id = $1`,
        [aut.id],
      );
      try {
        const m = app.get(MotorService);
        (m as unknown as { tokens: Map<string, unknown> }).tokens.clear();
        await expect(m.ejecutar(COD, 'listar_personas')).rejects.toThrow(
          /Falta el valor de \{\{secreto\.clave\}\}/,
        );
      } finally {
        await admin.query(
          `UPDATE integraciones.autenticacion SET secretos = jsonb_set(secretos, '{clave}', $2::jsonb) WHERE id = $1`,
          [aut.id, JSON.stringify(SECRETO_CLAVE)],
        );
      }
    });
  });

  describe('permisos', () => {
    it('exige un permiso distinto para ver, editar y probar', async () => {
      await http().get('/api/integraciones/proveedores').expect(401);
      const sin = { Authorization: `Bearer ${token([])}` };
      await http().get('/api/integraciones/proveedores').set(sin).expect(403);
      const soloVer = { Authorization: `Bearer ${token([P.INTEGRACIONES_VER])}` };
      await http().get('/api/integraciones/proveedores').set(soloVer).expect(200);
      await http()
        .put(`/api/integraciones/proveedores/${COD}`)
        .set(soloVer)
        .send({ activo: true })
        .expect(403);
      await http()
        .post(`/api/integraciones/operaciones/${uuidv7()}/probar`)
        .set(soloVer)
        .send({})
        .expect(403);
      await http()
        .post(`/api/integraciones/operaciones/${uuidv7()}/activar`)
        .set(soloVer)
        .expect(403);
    });
  });
});
