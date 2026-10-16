import './tracing';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app/app.module';
import type { GatewayEnv } from './app/env';
import { configureGateway } from './app/setup';

async function bootstrap() {
  // bodyParser desactivado: el gateway reenvía el cuerpo como flujo, no lo interpreta.
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  configureGateway(app);

  const port = app.get<ConfigService<GatewayEnv, true>>(ConfigService).get('PORT', { infer: true });
  await app.listen(port);
  Logger.log(`gateway escuchando en http://localhost:${port}`, 'Bootstrap');
}

void bootstrap();
