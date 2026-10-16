import { isIP } from 'node:net';
import type { Request } from 'express';
import type { ClientContext } from '../services/auth.service';

/** IP y agente del cliente para la tabla de sesiones. Solo se guarda una IP sintácticamente válida. */
export function clientContext(req: Request): ClientContext {
  const ip = req.ip && isIP(req.ip) ? req.ip : undefined;
  const ua = req.headers['user-agent'];
  return { ip, userAgent: Array.isArray(ua) ? ua[0] : ua };
}
