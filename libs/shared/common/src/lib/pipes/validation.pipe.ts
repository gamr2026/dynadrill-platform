import { ValidationPipe } from '@nestjs/common';

/**
 * Validación estándar de DTOs: descarta lo no declarado y rechaza campos extra
 * (OWASP "asignación masiva"), y convierte tipos de query/params.
 */
export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: false },
  });
}
