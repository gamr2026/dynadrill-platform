/**
 * Integración real del motor de secuenciales: Postgres (PgBouncer, usuario app_comercial).
 *   npm run infra:up && npm run db:migrate:comercial
 *   RUN_INTEGRATION=1 npx nx test pedidos
 * Los documentos de prueba se llaman `it_<n>` y se eliminan al final con dyn_migrator (la aplicación no tiene
 * DELETE). No toca los documentos reales (`pedido`, `pedido_cliente_as2`).
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
import { PedidosModule, SecuenciasService } from './index';
import { PrismaService } from './prisma/prisma.service';
import { quitarMaestros, sembrarMaestros, type MaestrosDePrueba } from './testing/maestros';
import { sinSuscripciones } from './testing/sin-suscripciones';

const run = process.env['RUN_INTEGRATION'] ? describe : describe.skip;

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const APP_DB =
  process.env['TEST_COMERCIAL_DATABASE_URL'] ??
  'postgresql://app_comercial:dev_app_comercial@localhost:6432/dynadrill?pgbouncer=true';
const MIGRATOR_DB =
  process.env['TEST_MIGRATOR_DATABASE_URL'] ??
  'postgresql://dyn_migrator:dev_dyn_migrator@localhost:5433/dynadrill';

const n = Date.now();
const ACTOR = uuidv7();
/** La bitácora de emisiones guarda quién emitió (FK a identidad): la cuenta de prueba existe de verdad. */
const MAESTROS: MaestrosDePrueba = {
  usuarios: [{ id: ACTOR, nombre: 'Fabiola Facturación', rol: 'facturacion' }],
};

run('secuenciales (base de datos real)', () => {
  jest.setTimeout(60000);
  let app: INestApplication;
  let prisma: PrismaService;
  let secuencias: SecuenciasService;
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

  /** Crea un documento de prueba con su secuencia y devuelve el código del documento. */
  async function documento(
    sufijo: string,
    sec: Partial<{
      prefijo: string;
      longitud: number;
      rangoDesde: number;
      rangoHasta: number;
      numeroActual: number;
      reinicio: 'nunca' | 'anual';
      anio: number;
      vigenciaDesde: Date;
      vigenciaHasta: Date;
      hacerCumplirVigencia: boolean;
    }> = {},
    emitePortal = true,
  ) {
    const codigo = `it_${n}_${sufijo}`;
    const id = uuidv7();
    await prisma.documento.create({
      data: { id, codigo, nombre: `Prueba ${sufijo}`, emitePortal },
    });
    const s = await prisma.secuencia.create({
      data: { id: uuidv7(), documentoId: id, rangoDesde: 1, rangoHasta: 999999, ...sec },
    });
    return { codigo, documentoId: id, secuenciaId: s.id };
  }

  beforeAll(async () => {
    Object.assign(process.env, {
      SERVICE_NAME: 'comercial-test',
      PORT: '3195',
      LOG_LEVEL: 'silent',
      DATABASE_URL: APP_DB,
      RABBITMQ_URL: 'amqp://x:x@localhost:5672',
      JWT_PUBLIC_KEY: publicKey,
    });
    const envSchema = defineEnv(baseEnvSchema, databaseEnvSchema, jwtVerifyEnvSchema);
    await sembrarMaestros(admin, MAESTROS);

    @Module({
      imports: [
        AppConfigModule.forRoot(envSchema),
        CommonModule.forRoot({ serviceName: 'comercial-test' }),
        MessagingModule.forRoot({
          container: 'comercial',
          schema: 'msg_comercial',
          rabbitUrl: 'amqp://x:x@localhost:5672',
          databaseUrl: APP_DB,
          relay: { enabled: false },
        }),
        PedidosModule,
      ],
    })
    class TestAppModule {}

    const mod = await Test.createTestingModule({ imports: [TestAppModule] }).compile();
    app = mod.createNestApplication();
    configureApp(app, { corsOrigins: ['http://localhost:4200'] });
    sinSuscripciones();
    await app.init();
    prisma = app.get(PrismaService);
    secuencias = app.get(SecuenciasService);
  });

  afterAll(async () => {
    await admin.query(
      `DELETE FROM comercial.secuencia_emision WHERE secuencia_id IN
         (SELECT s.id FROM comercial.secuencia s JOIN comercial.documento d ON d.id = s.documento_id WHERE d.codigo LIKE 'it\\_%')`,
    );
    await admin.query(
      `DELETE FROM comercial.secuencia WHERE documento_id IN (SELECT id FROM comercial.documento WHERE codigo LIKE 'it\\_%')`,
    );
    await admin.query(`DELETE FROM comercial.documento WHERE codigo LIKE 'it\\_%'`);
    await quitarMaestros(admin, MAESTROS);
    await admin.end();
    await app.close();
  });

  const emitir = (documento: string, extra: Record<string, unknown> = {}) =>
    prisma.$transaction((tx) =>
      secuencias.emitir(tx, { documento, actorId: ACTOR, documentoRefId: uuidv7(), ...extra }),
    );

  it('emite en orden con el formato del documento y deja la bitácora', async () => {
    const d = await documento('pec', { prefijo: 'PEC-', longitud: 10, numeroActual: 4674 });
    const a = await emitir(d.codigo);
    const b = await emitir(d.codigo);
    expect([a.numero, a.codigo]).toEqual([4675, 'PEC-004675']);
    expect([b.numero, b.codigo]).toEqual([4676, 'PEC-004676']);

    const filas = await prisma.secuenciaEmision.findMany({
      where: { secuenciaId: d.secuenciaId },
      orderBy: { numero: 'asc' },
    });
    expect(filas.map((f) => [f.numero, f.codigoFormateado, f.estado, f.emitidoPor])).toEqual([
      [4675, 'PEC-004675', 'emitido', ACTOR],
      [4676, 'PEC-004676', 'emitido', ACTOR],
    ]);
    expect(
      (await prisma.secuencia.findUniqueOrThrow({ where: { id: d.secuenciaId } })).numeroActual,
    ).toBe(4676);
  });

  it('25 emisiones simultáneas dan 25 números distintos y consecutivos, sin duplicados ni saltos', async () => {
    const d = await documento('conc', { numeroActual: 100 });
    const r = await Promise.all(Array.from({ length: 25 }, () => emitir(d.codigo)));
    const numeros = r.map((x) => x.numero).sort((x, y) => x - y);
    expect(numeros).toEqual(Array.from({ length: 25 }, (_, i) => 101 + i));
    expect(new Set(r.map((x) => x.codigo)).size).toBe(25);
    expect(
      (await prisma.secuencia.findUniqueOrThrow({ where: { id: d.secuenciaId } })).numeroActual,
    ).toBe(125);
  });

  it('si la transacción falla el número NO se consume (sin saltos), a diferencia de una secuencia de PostgreSQL', async () => {
    const d = await documento('rev', { numeroActual: 10 });
    await expect(
      prisma.$transaction(async (tx) => {
        const e = await secuencias.emitir(tx, { documento: d.codigo, documentoRefId: uuidv7() });
        expect(e.numero).toBe(11);
        throw new Error('falla al guardar el pedido');
      }),
    ).rejects.toThrow('falla al guardar el pedido');

    const siguiente = await emitir(d.codigo);
    expect(siguiente.numero).toBe(11); // el 11 no se perdió
    expect(await prisma.secuenciaEmision.count({ where: { secuenciaId: d.secuenciaId } })).toBe(1);
  });

  it('al llegar al final del rango falla con un error claro y no emite', async () => {
    const d = await documento('rango', { rangoDesde: 1, rangoHasta: 3, numeroActual: 2 });
    expect((await emitir(d.codigo)).numero).toBe(3);
    await expect(emitir(d.codigo)).rejects.toThrow(/final de su rango/);
    expect(
      (await prisma.secuencia.findUniqueOrThrow({ where: { id: d.secuenciaId } })).numeroActual,
    ).toBe(3);
  });

  it('un documento que asigna AS2 no se puede emitir desde el portal', async () => {
    const d = await documento('as2', { prefijo: 'PEC-', longitud: 10, numeroActual: 50 }, false);
    await expect(emitir(d.codigo)).rejects.toThrow(/lo asigna AS2/);
    await expect(emitir(`it_${n}_no_existe`)).rejects.toThrow(/no existe/);
  });

  it('secuencia anual: usa la del año de la fecha y falla si no hay una para ese año', async () => {
    const d = await documento('anual', {
      reinicio: 'anual',
      anio: 2026,
      prefijo: 'T-2026-',
      longitud: 12,
      numeroActual: 0,
    });
    const e = await emitir(d.codigo, { fecha: new Date('2026-10-14T12:00:00Z') });
    expect(e.codigo).toBe('T-2026-00001');
    await expect(emitir(d.codigo, { fecha: new Date('2027-01-02T12:00:00Z') })).rejects.toThrow(
      /en 2027/,
    );
  });

  it('la vigencia es informativa, salvo que se active hacer_cumplir_vigencia', async () => {
    const vencida = {
      vigenciaDesde: new Date('2012-10-09'),
      vigenciaHasta: new Date('2020-12-31'),
    };
    const informativa = await documento('vig1', { ...vencida, numeroActual: 4674 });
    expect(
      (await emitir(informativa.codigo, { fecha: new Date('2026-10-14T12:00:00Z') })).numero,
    ).toBe(4675);

    const estricta = await documento('vig2', { ...vencida, hacerCumplirVigencia: true });
    await expect(
      emitir(estricta.codigo, { fecha: new Date('2026-10-14T12:00:00Z') }),
    ).rejects.toThrow(/no está vigente/);
  });

  it('un número emitido sin documento queda huérfano y se puede asignar después; uno anulado no se reutiliza', async () => {
    const d = await documento('huer', { numeroActual: 0 });
    const sinDoc = await prisma.$transaction((tx) =>
      secuencias.emitir(tx, { documento: d.codigo }),
    );
    const fila = await prisma.secuenciaEmision.findUniqueOrThrow({
      where: { id: sinDoc.emisionId },
    });
    expect(fila.estado).toBe('huerfano');

    const pedidoId = uuidv7();
    await prisma.$transaction((tx) => secuencias.asignar(tx, sinDoc.emisionId, pedidoId));
    expect(
      await prisma.secuenciaEmision.findUniqueOrThrow({ where: { id: sinDoc.emisionId } }),
    ).toMatchObject({
      estado: 'emitido',
      documentoRefId: pedidoId,
    });
    await expect(
      prisma.$transaction((tx) => secuencias.asignar(tx, sinDoc.emisionId, uuidv7())),
    ).rejects.toThrow(/ya está asignado/);

    await secuencias.anular(sinDoc.emisionId, 'pedido duplicado');
    expect((await emitir(d.codigo)).numero).toBe(2); // el 1 anulado no vuelve
    await expect(secuencias.anular(sinDoc.emisionId, 'otra vez')).rejects.toThrow(
      /ya estaba anulado/,
    );
    await expect(secuencias.anular(sinDoc.emisionId, ' ')).rejects.toThrow(/obligatorio/);
  });

  it('la base de datos protege la bitácora: sin duplicados y sin cambiar el número ni borrar', async () => {
    const d = await documento('prot', { numeroActual: 0 });
    const e = await emitir(d.codigo);
    // duplicado (secuencia, numero)
    await expect(
      prisma.secuenciaEmision.create({
        data: {
          id: uuidv7(),
          secuenciaId: d.secuenciaId,
          numero: e.numero,
          codigoFormateado: 'X',
          estado: 'emitido',
        },
      }),
    ).rejects.toThrow();
    // el número y el código no se pueden cambiar (privilegio por columna)
    await expect(
      prisma.secuenciaEmision.update({ where: { id: e.emisionId }, data: { numero: 999 } }),
    ).rejects.toThrow();
    // la aplicación no puede borrar
    await expect(prisma.secuenciaEmision.delete({ where: { id: e.emisionId } })).rejects.toThrow();
    // y no se puede dejar la secuencia fuera de su rango
    await expect(
      prisma.secuencia.update({ where: { id: d.secuenciaId }, data: { numeroActual: 5_000_000 } }),
    ).rejects.toThrow();
  });

  it('los datos sembrados: el pedido del portal y el espejo de AS2 (que el portal no emite)', async () => {
    const pedido = await prisma.documento.findUnique({
      where: { codigo: 'pedido' },
      include: { secuencias: true },
    });
    const pec = await prisma.documento.findUnique({
      where: { codigo: 'pedido_cliente_as2' },
      include: { secuencias: true },
    });
    expect(pedido).toMatchObject({ emitePortal: true });
    expect(pec).toMatchObject({ emitePortal: false, nombreAs2: 'PEDIDOS CLIENTES' });
    expect(pec?.secuencias[0]).toMatchObject({
      prefijo: 'PEC-',
      longitud: 10,
      origen: 'as2',
      hacerCumplirVigencia: false,
    });
  });

  describe('API de consulta', () => {
    const conPermiso = () => ({
      Authorization: `Bearer ${token([Permission.SECUENCIAS_VER, Permission.SECUENCIAS_EDITAR])}`,
    });

    it('exige permiso para ver y para anular', async () => {
      await http().get('/api/comercial/secuencias').expect(401);
      await http()
        .get('/api/comercial/secuencias')
        .set({ Authorization: `Bearer ${token([])}` })
        .expect(403);
      const soloVer = { Authorization: `Bearer ${token([Permission.SECUENCIAS_VER])}` };
      await http().get('/api/comercial/secuencias').set(soloVer).expect(200);
      await http()
        .post(`/api/comercial/secuencias/emisiones/${uuidv7()}/anular`)
        .set(soloVer)
        .send({ motivo: 'prueba' })
        .expect(403);
    });

    it('lista las secuencias con el siguiente número y muestra sus emisiones; anular exige motivo', async () => {
      const d = await documento('api', { prefijo: 'API-', longitud: 8, numeroActual: 9 });
      const e = await emitir(d.codigo);
      const lista = (await http().get('/api/comercial/secuencias').set(conPermiso()).expect(200))
        .body;
      const fila = lista.find((s: { id: string }) => s.id === d.secuenciaId);
      expect(fila).toMatchObject({
        documento: d.codigo,
        emitePortal: true,
        numeroActual: 10,
        siguiente: 11,
        prefijo: 'API-',
      });
      expect(
        lista.find((s: { documento: string }) => s.documento === 'pedido_cliente_as2'),
      ).toMatchObject({
        emitePortal: false,
        siguiente: null,
      });

      const em = (
        await http()
          .get(`/api/comercial/secuencias/${d.secuenciaId}/emisiones`)
          .set(conPermiso())
          .expect(200)
      ).body;
      expect(em[0]).toMatchObject({ numero: 10, codigoFormateado: 'API-0010', estado: 'emitido' });

      await http()
        .post(`/api/comercial/secuencias/emisiones/${e.emisionId}/anular`)
        .set(conPermiso())
        .send({ motivo: 'x' })
        .expect(400);
      await http()
        .post(`/api/comercial/secuencias/emisiones/${e.emisionId}/anular`)
        .set(conPermiso())
        .send({ motivo: 'pedido duplicado' })
        .expect(201);
      const despues = (
        await http()
          .get(`/api/comercial/secuencias/${d.secuenciaId}/emisiones`)
          .set(conPermiso())
          .expect(200)
      ).body;
      expect(despues[0]).toMatchObject({ estado: 'anulado', motivo: 'pedido duplicado' });
    });
  });
});
