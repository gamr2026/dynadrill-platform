/**
 * Arranque común de las pruebas de integración de QHSE: la aplicación real sobre PostgreSQL (PgBouncer, app_qhse), sin RabbitMQ, con un
 * firmante de tokens RS256 y un `Pool` de dyn_migrator para sembrar y limpiar. Solo para pruebas.
 */
import { INestApplication, Module } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { generateKeyPairSync } from 'node:crypto';
import { Pool } from 'pg';
import request from 'supertest';
import {
  AppConfigModule,
  baseEnvSchema,
  databaseEnvSchema,
  defineEnv,
  jwtVerifyEnvSchema,
} from '@dyn/config';
import { CommonModule, configureApp } from '@dyn/common';
import { MessagingModule } from '@dyn/messaging';
import { ArticulosEpiConsumer } from '../consumers/articulos-epi.consumer';
import { PumpingEventosConsumer } from '../consumers/pumping-eventos.consumer';
import { PrismaService } from '../prisma/prisma.service';
import { QhseModule } from '../qhse.module';

export const APP_DB =
  process.env['TEST_QHSE_DATABASE_URL'] ??
  'postgresql://app_qhse:dev_app_qhse@localhost:6432/dynadrill?pgbouncer=true';
export const MIGRATOR_DB =
  process.env['TEST_MIGRATOR_DATABASE_URL'] ??
  'postgresql://dyn_migrator:dev_dyn_migrator@localhost:5433/dynadrill';

export interface AppDePrueba {
  app: INestApplication;
  prisma: PrismaService;
  admin: Pool;
  http: () => ReturnType<typeof request>;
  /** Cabecera `Authorization` de una cuenta con esos permisos. */
  token: (
    roleCode: string,
    name: string,
    permissions: string[],
    sub: string,
  ) => { Authorization: string };
  cerrar: () => Promise<void>;
}

export async function levantarAppDePrueba(puerto: string): Promise<AppDePrueba> {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  Object.assign(process.env, {
    SERVICE_NAME: 'qhse-test',
    PORT: puerto,
    LOG_LEVEL: 'silent',
    DATABASE_URL: APP_DB,
    RABBITMQ_URL: 'amqp://x:x@localhost:5672',
    JWT_PUBLIC_KEY: publicKey,
  });
  const envSchema = defineEnv(baseEnvSchema, databaseEnvSchema, jwtVerifyEnvSchema);
  @Module({
    imports: [
      AppConfigModule.forRoot(envSchema),
      CommonModule.forRoot({ serviceName: 'qhse-test' }),
      MessagingModule.forRoot({
        container: 'qhse',
        schema: 'msg_qhse',
        rabbitUrl: 'amqp://x:x@localhost:5672',
        databaseUrl: APP_DB,
        relay: { enabled: false },
      }),
      QhseModule,
    ],
  })
  class TestAppModule {}
  const mod = await Test.createTestingModule({ imports: [TestAppModule] }).compile();
  const app = mod.createNestApplication();
  configureApp(app, { corsOrigins: ['http://localhost:4200'] });
  // sin RabbitMQ: los consumidores se invocan a mano; se evita que intenten suscribirse al arrancar
  for (const c of [PumpingEventosConsumer, ArticulosEpiConsumer]) {
    jest.spyOn(c.prototype, 'onApplicationBootstrap').mockResolvedValue(undefined);
  }
  await app.init();
  const signer = new JwtService({
    privateKey,
    signOptions: { algorithm: 'RS256', issuer: 'dynadrill-plataforma', expiresIn: 600 },
  });
  const admin = new Pool({ connectionString: MIGRATOR_DB, max: 2 });
  return {
    app,
    prisma: app.get(PrismaService),
    admin,
    http: () => request(app.getHttpServer()),
    token: (roleCode, name, permissions, sub) => ({
      Authorization: `Bearer ${signer.sign({ sub, email: `${roleCode}@test.local`, name, roleId: 'r', roleCode, permissions })}`,
    }),
    cerrar: async () => {
      await admin.end();
      await app.close();
    },
  };
}
