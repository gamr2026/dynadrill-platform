import pino, { Logger } from 'pino';

/** Logs JSON estructurados. Nunca se registran tokens ni cabeceras de autorización. */
export function createLogger(service: string, level = process.env['LOG_LEVEL'] ?? 'info'): Logger {
  return pino({
    level,
    base: { service },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: ['req.headers.authorization', 'password', '*.password', '*.password_hash'],
      remove: true,
    },
  });
}
