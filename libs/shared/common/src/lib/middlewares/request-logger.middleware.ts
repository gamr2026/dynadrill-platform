import { Inject, Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import type { Logger } from 'pino';
import type { AuthUser } from '../auth/auth-user';

export const APP_LOGGER = Symbol('APP_LOGGER');

/** Una línea JSON por petición: método, ruta, estado, duración, requestId y usuario. */
@Injectable()
export class RequestLoggerMiddleware implements NestMiddleware {
  constructor(@Inject(APP_LOGGER) private readonly logger: Logger) {}

  use(req: Request & { id?: string; user?: AuthUser }, res: Response, next: NextFunction): void {
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
      this.logger[level]({
        requestId: req.id,
        method: req.method,
        path: req.originalUrl.split('?')[0],
        status: res.statusCode,
        durationMs: Math.round(ms * 10) / 10,
        userId: req.user?.id,
        role: req.user?.roleCode,
      });
    });
    next();
  }
}
