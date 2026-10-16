/**
 * Integración real del contenedor plataforma: Postgres (vía PgBouncer) + RabbitMQ.
 *   npm run infra:up && RUN_INTEGRATION=1 npx nx test plataforma
 * Sin RUN_INTEGRATION se omite.
 */
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { generateKeyPairSync } from 'node:crypto';
import request from 'supertest';
import { configureApp } from '@dyn/common';

const run = process.env['RUN_INTEGRATION'] ? describe : describe.skip;

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

run('plataforma: outbox → RabbitMQ → inbox (infraestructura real)', () => {
  jest.setTimeout(30000);
  let app: INestApplication;
  const signer = new JwtService({
    privateKey,
    signOptions: { algorithm: 'RS256', issuer: 'dynadrill-plataforma' },
  });
  const token = (roleCode: string) =>
    signer.sign({
      sub: '0192f7a4-5c1e-7b3a-9e21-8d4c6a1f0b77',
      email: 'a@b.c',
      roleId: 'r',
      roleCode,
    });

  beforeAll(async () => {
    Object.assign(process.env, {
      SERVICE_NAME: 'plataforma',
      PORT: '3199',
      LOG_LEVEL: 'silent',
      JWT_PUBLIC_KEY: publicKey,
      DIAGNOSTICO_ENABLED: 'true',
      DATABASE_URL:
        process.env['TEST_DATABASE_URL'] ??
        'postgresql://app_plataforma:dev_app_plataforma@localhost:6432/dynadrill?pgbouncer=true',
      RABBITMQ_URL:
        process.env['TEST_RABBITMQ_URL'] ?? 'amqp://dynadrill:dev_rabbitmq@localhost:5672',
      OUTBOX_RELAY_INTERVAL_MS: '100',
    });
    // el módulo valida el entorno al importarse, por eso se carga después de fijarlo
    const { AppModule } = await import('./app.module');
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    configureApp(app, { corsOrigins: ['http://localhost:4200'] });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('exige token y rol: 401 sin token, 403 con rol insuficiente', async () => {
    await request(app.getHttpServer()).post('/api/plataforma/diagnostico/evento').expect(401);
    await request(app.getHttpServer())
      .post('/api/plataforma/diagnostico/evento')
      .set('Authorization', `Bearer ${token('operador')}`)
      .expect(403);
  });

  it('un evento emitido se publica y se procesa una sola vez', async () => {
    const auth = { Authorization: `Bearer ${token('superadmin')}` };
    const res = await request(app.getHttpServer())
      .post('/api/plataforma/diagnostico/evento')
      .set(auth)
      .expect(201);
    const { eventId } = res.body as { eventId: string };

    let estado: { publicado: boolean; procesado: boolean } = { publicado: false, procesado: false };
    for (let i = 0; i < 100 && !(estado.publicado && estado.procesado); i++) {
      await new Promise((r) => setTimeout(r, 100));
      estado = (
        await request(app.getHttpServer())
          .get(`/api/plataforma/diagnostico/evento/${eventId}`)
          .set(auth)
          .expect(200)
      ).body;
    }
    expect(estado).toMatchObject({
      publicado: true,
      procesado: true,
      intentos: 0,
      ultimoError: null,
    });
  });

  it('el evento inexistente responde 404 y un id mal formado 400', async () => {
    const auth = { Authorization: `Bearer ${token('superadmin')}` };
    await request(app.getHttpServer())
      .get('/api/plataforma/diagnostico/evento/0192f7a4-5c1e-7b3a-9e21-8d4c6a1f0b00')
      .set(auth)
      .expect(404);
    await request(app.getHttpServer())
      .get('/api/plataforma/diagnostico/evento/no-es-uuid')
      .set(auth)
      .expect(400);
  });
});
