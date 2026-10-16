import { INestApplication } from '@nestjs/common';
import helmet from 'helmet';
import { ProblemDetailsFilter } from './filters/problem-details.filter';
import { createValidationPipe } from './pipes/validation.pipe';

export interface ConfigureAppOptions {
  corsOrigins: string[];
  /** Prefijo global; el frontend ya usa `/api/...`. Health queda fuera. */
  globalPrefix?: string;
  /** Saltos de proxy de confianza (el gateway = 1): hace que `req.ip` sea la IP real del cliente. */
  trustProxy?: number;
}

/** Configuración HTTP estándar de un contenedor: prefijo, CORS estricto, helmet, validación y errores. */
export function configureApp(app: INestApplication, options: ConfigureAppOptions): void {
  if (options.trustProxy) {
    (app.getHttpAdapter().getInstance() as { set(k: string, v: unknown): void }).set(
      'trust proxy',
      options.trustProxy,
    );
  }
  app.setGlobalPrefix(options.globalPrefix ?? 'api', { exclude: ['health/live', 'health/ready'] });
  app.use(helmet());
  app.enableCors({ origin: options.corsOrigins, credentials: true });
  app.useGlobalPipes(createValidationPipe());
  app.useGlobalFilters(new ProblemDetailsFilter());
  app.enableShutdownHooks();
}
