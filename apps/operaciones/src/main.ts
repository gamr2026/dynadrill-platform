import './tracing';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { configureApp } from '@dyn/common';
import { parseCorsOrigins } from '@dyn/config';
import { AppModule } from './app/app.module';
import type { OperacionesEnv } from './app/env';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const cfg = app.get<ConfigService<OperacionesEnv, true>>(ConfigService);

  configureApp(app, {
    corsOrigins: parseCorsOrigins(cfg.get('CORS_ORIGIN', { infer: true })),
    trustProxy: 1, // detrás del gateway
  });

  const port = cfg.get('PORT', { infer: true });
  await app.listen(port);
  Logger.log(`operaciones escuchando en http://localhost:${port}`, 'Bootstrap');
}

void bootstrap();
