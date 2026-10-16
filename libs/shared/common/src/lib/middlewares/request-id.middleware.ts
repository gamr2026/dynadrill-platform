import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/** Máximo razonable para un id entrante; evita inyectar cabeceras enormes en los logs. */
const MAX_ID_LENGTH = 128;

/**
 * Asigna `request.id`: respeta `x-request-id` si llega bien formado (lo pone el gateway) y lo
 * devuelve en la respuesta. Es el `correlationId` que viaja en logs, errores y eventos.
 */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request & { id?: string }, res: Response, next: NextFunction): void {
    const incoming = req.headers['x-request-id'];
    const candidate = Array.isArray(incoming) ? incoming[0] : incoming;
    req.id =
      candidate && candidate.length <= MAX_ID_LENGTH && /^[\w.:-]+$/.test(candidate)
        ? candidate
        : randomUUID();
    res.setHeader('x-request-id', req.id);
    next();
  }
}
