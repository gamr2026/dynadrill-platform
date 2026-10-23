/**
 * Arranque común de las pruebas de integración de auditoría: la aplicación real sobre PostgreSQL, sin RabbitMQ (el consumidor se
 * invoca directamente) y con un par de llaves propio para firmar tokens de prueba.
 */
import { INestApplication, Module } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { generateKeyPairSync } from 'node:crypto';
import { Pool } from 'pg';
import {
  AppConfigModule,
  baseEnvSchema,
  databaseEnvSchema,
  defineEnv,
  jwtVerifyEnvSchema,
} from '@dyn/config';
import { CommonModule, configureApp } from '@dyn/common';
import { MessagingModule, type EventEnvelope } from '@dyn/messaging';
import { uuidv7 } from '@dyn/utils';
import { AuditoriaModule } from '../auditoria.module';
import { AuditoriaConsumer } from '../consumers/auditoria.consumer';
import { PrismaService } from '../prisma/prisma.service';

export const APP_DB =
  process.env['TEST_PLATAFORMA_DATABASE_URL'] ??
  'postgresql://app_plataforma:dev_app_plataforma@localhost:6432/dynadrill?pgbouncer=true';
export const MIGRATOR_DB =
  process.env['TEST_MIGRATOR_DATABASE_URL'] ??
  'postgresql://dyn_migrator:dev_dyn_migrator@localhost:5433/dynadrill';

export interface AppDePrueba {
  app: INestApplication;
  prisma: PrismaService;
  consumer: AuditoriaConsumer;
  /** Firma un token con esos permisos (la cuenta es la indicada). */
  token: (usuarioId: string, permisos: string[]) => string;
}

export async function arrancarApp(puerto: string): Promise<AppDePrueba> {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  Object.assign(process.env, {
    SERVICE_NAME: 'auditoria-test',
    PORT: puerto,
    LOG_LEVEL: 'silent',
    DATABASE_URL: APP_DB,
    RABBITMQ_URL: 'amqp://x:x@localhost:5672',
    JWT_PUBLIC_KEY: publicKey,
  });
  @Module({
    imports: [
      AppConfigModule.forRoot(defineEnv(baseEnvSchema, databaseEnvSchema, jwtVerifyEnvSchema)),
      CommonModule.forRoot({ serviceName: 'auditoria-test' }),
      MessagingModule.forRoot({
        container: 'plataforma',
        schema: 'msg_plataforma',
        rabbitUrl: 'amqp://x:x@localhost:5672',
        databaseUrl: APP_DB,
        relay: { enabled: false },
      }),
      AuditoriaModule,
    ],
  })
  class TestAppModule {}
  jest.spyOn(AuditoriaConsumer.prototype, 'onApplicationBootstrap').mockResolvedValue(undefined);
  const mod = await Test.createTestingModule({ imports: [TestAppModule] }).compile();
  const app = mod.createNestApplication();
  configureApp(app, { corsOrigins: ['http://localhost:4200'] });
  await app.init();
  const signer = new JwtService({
    privateKey,
    signOptions: { algorithm: 'RS256', issuer: 'dynadrill-plataforma', expiresIn: 600 },
  });
  return {
    app,
    prisma: app.get(PrismaService),
    consumer: app.get(AuditoriaConsumer),
    token: (usuarioId, permisos) =>
      signer.sign({
        sub: usuarioId,
        email: 'prueba@dynadrill.test',
        name: 'Prueba',
        roleId: uuidv7(),
        roleCode: 'prueba',
        permissions: permisos,
      }),
  };
}

/** Borra lo que las pruebas crearon: la historia solo se puede limpiar con la excepción explícita de dyn_migrator. */
export async function limpiar(
  admin: Pool,
  o: { eventos: string[]; tipos: string[]; sujetoTipos: string[] },
): Promise<void> {
  const c = await admin.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SET LOCAL auditoria.limpieza_de_pruebas = 'on'`);
    await c.query(`DELETE FROM auditoria.evento_auditado_dato WHERE evento_id = ANY($1::uuid[])`, [
      o.eventos,
    ]);
    await c.query(`DELETE FROM auditoria.evento_auditado WHERE id = ANY($1::uuid[])`, [o.eventos]);
    await c.query('COMMIT');
  } finally {
    c.release();
  }
  await admin.query(`DELETE FROM auditoria.tipo_evento WHERE codigo = ANY($1::text[])`, [o.tipos]);
  await admin.query(`DELETE FROM auditoria.sujeto_tipo WHERE codigo = ANY($1::text[])`, [
    o.sujetoTipos,
  ]);
  await admin.query(`DELETE FROM msg_plataforma.inbox WHERE id = ANY($1::uuid[])`, [o.eventos]);
}

export function sobre(
  tipo: string,
  sujeto: { type: string; id: string },
  extra: Partial<EventEnvelope> = {},
): EventEnvelope {
  return {
    id: uuidv7(),
    type: tipo,
    version: 1,
    occurredAt: new Date().toISOString(),
    source: 'operaciones',
    subject: sujeto,
    data: {},
    ...extra,
  };
}
