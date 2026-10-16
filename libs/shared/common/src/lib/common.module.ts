import {
  DynamicModule,
  Global,
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
} from '@nestjs/common';
import { SecurityModule } from './auth/security.module';
import { HealthController } from './health/health.controller';
import { createLogger } from './logging/logger';
import { RequestIdMiddleware } from './middlewares/request-id.middleware';
import { APP_LOGGER, RequestLoggerMiddleware } from './middlewares/request-logger.middleware';

export interface CommonModuleOptions {
  /** Nombre del contenedor para los logs (`plataforma`, `gateway`...). */
  serviceName: string;
  /** Desactiva JWT/roles (solo para el gateway si valida por su cuenta, o pruebas). Por defecto activo. */
  security?: boolean;
}

/**
 * Piezas comunes de todo contenedor: request-id, log por petición, health, JWT global y política
 * de roles. Requiere `AppConfigModule` (con `jwtVerifyEnvSchema` si `security` está activo).
 */
@Global()
@Module({})
export class CommonModule implements NestModule {
  static forRoot(options: CommonModuleOptions): DynamicModule {
    return {
      module: CommonModule,
      imports: options.security === false ? [] : [SecurityModule],
      controllers: [HealthController],
      providers: [{ provide: APP_LOGGER, useValue: createLogger(options.serviceName) }],
      exports: [APP_LOGGER],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(RequestIdMiddleware, RequestLoggerMiddleware)
      .forRoutes({ path: '{*splat}', method: RequestMethod.ALL });
  }
}
