import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { parseCorsOrigins } from '@dyn/config';
import { ProblemDetailsFilter } from '@dyn/common';
import type { GatewayEnv } from './env';

/** Seguridad HTTP del gateway: cabeceras, CORS, límite de peticiones y formato de errores. */
export function configureGateway(app: INestApplication): void {
  const cfg = app.get<ConfigService<GatewayEnv, true>>(ConfigService);

  app.use(helmet());
  app.enableCors({
    origin: parseCorsOrigins(cfg.get('CORS_ORIGIN', { infer: true })),
    credentials: true,
  });
  const tooMany = {
    type: 'https://dynadrill.com/problemas/429',
    title: 'TOO_MANY_REQUESTS',
    status: 429,
    statusCode: 429,
    detail: 'Demasiadas peticiones; intente nuevamente en un momento',
    message: 'Demasiadas peticiones; intente nuevamente en un momento',
  };
  // el login se limita primero y por separado: es el blanco de la fuerza bruta
  app.use(
    '/api/auth/login',
    rateLimit({
      windowMs: 60_000,
      limit: cfg.get('LOGIN_RATE_LIMIT_PER_MINUTE', { infer: true }),
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: tooMany,
    }),
  );
  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: cfg.get('RATE_LIMIT_PER_MINUTE', { infer: true }),
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      skip: (req) => req.path.startsWith('/health'),
      message: tooMany,
    }),
  );
  app.useGlobalFilters(new ProblemDetailsFilter());
  app.enableShutdownHooks();
}
