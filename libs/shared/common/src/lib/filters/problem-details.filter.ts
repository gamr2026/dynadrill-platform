import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';

/**
 * Cuerpo de error: RFC 7807 (`application/problem+json`) más los campos que ya lee el frontend
 * (`statusCode`, `error`, `message`, `path`, `method`, `timestamp`). Los campos viejos se mantienen
 * mientras el contrato HTTP del frontend esté congelado (documento de arquitectura, ADR-007).
 */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
  requestId: string;
  /** Código de negocio opcional, ej. `STOCK_INSUFICIENTE`. */
  code?: string;
  // compatibilidad con el contrato actual del frontend
  statusCode: number;
  error: string;
  message: string | string[];
  path: string;
  method: string;
  timestamp: string;
}

/**
 * Columnas de una violación de unicidad (P2002). Prisma con el motor clásico trae `meta.target`; con el
 * adaptador `pg` (Prisma 7) trae `driverAdapterError.cause.constraint`, ya sea con `fields` o solo con el
 * nombre del índice (`<tabla>_<columnas>_key`), del que se deduce la columna. Si nada sirve: "campo único".
 */
export function uniqueTarget(meta?: Record<string, unknown>): string {
  const target = meta?.['target'];
  if (Array.isArray(target) && target.length) return target.join(', ');

  const cause = (meta?.['driverAdapterError'] as { cause?: Record<string, unknown> } | undefined)
    ?.cause;
  const constraint = cause?.['constraint'] as { fields?: unknown; index?: unknown } | undefined;
  if (Array.isArray(constraint?.fields) && constraint.fields.length)
    return constraint.fields.join(', ');

  const index = constraint?.index;
  if (typeof index === 'string') {
    const table = typeof cause?.['table'] === 'string' ? (cause['table'] as string) : '';
    let columnas = index.replace(/_(key|idx|unique)$/, '');
    if (table && columnas.startsWith(`${table}_`)) columnas = columnas.slice(table.length + 1);
    if (columnas) return columnas.replace(/_/g, ' ');
  }
  return 'campo único';
}

/** Errores conocidos de Prisma → HTTP. Se detecta por nombre para no depender del cliente de un módulo. */
function mapPrismaError(
  code: string,
  meta?: Record<string, unknown>,
): { status: number; message: string } {
  switch (code) {
    case 'P2000':
      return {
        status: HttpStatus.BAD_REQUEST,
        message: 'Un valor excede el largo permitido para su columna.',
      };
    case 'P2002': {
      return {
        status: HttpStatus.CONFLICT,
        message: `Ya existe un registro con ese valor en: ${uniqueTarget(meta)}`,
      };
    }
    case 'P2003':
      return {
        status: HttpStatus.BAD_REQUEST,
        message: 'Referencia inválida: el registro relacionado no existe.',
      };
    case 'P2011':
      return { status: HttpStatus.BAD_REQUEST, message: 'Falta un campo obligatorio.' };
    case 'P2025':
      return { status: HttpStatus.NOT_FOUND, message: 'El registro no existe.' };
    default:
      return { status: HttpStatus.INTERNAL_SERVER_ERROR, message: 'Error interno del servidor' };
  }
}

function isPrismaKnownError(
  e: unknown,
): e is { name: string; code: string; meta?: Record<string, unknown> } {
  return (
    typeof e === 'object' &&
    e !== null &&
    (e as { name?: string }).name === 'PrismaClientKnownRequestError'
  );
}

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const request = http.getRequest<Request & { id?: string }>();
    const requestId = request.id ?? randomUUID();

    let status = HttpStatus.INTERNAL_SERVER_ERROR as number;
    let message: string | string[] = 'Error interno del servidor';
    let code: string | undefined;
    let unexpected = true;

    if (exception instanceof HttpException) {
      unexpected = false;
      status = exception.getStatus();
      const res = exception.getResponse();
      if (typeof res === 'string') {
        message = res;
      } else {
        const body = res as { message?: string | string[]; code?: string };
        message = body.message ?? exception.message;
        code = body.code;
      }
    } else if (isPrismaKnownError(exception)) {
      ({ status, message } = mapPrismaError(exception.code, exception.meta));
      unexpected = status === HttpStatus.INTERNAL_SERVER_ERROR;
    }

    if (unexpected) {
      this.logger.error(
        `[${requestId}] ${request.method} ${request.url} — ${(exception as Error)?.stack ?? String(exception)}`,
      );
    }

    const title = HttpStatus[status] ?? 'ERROR';
    const detail = Array.isArray(message) ? message.join('; ') : message;
    const body: ProblemDetails = {
      type: `https://dynadrill.com/problemas/${status}`,
      title,
      status,
      detail,
      instance: request.url,
      requestId,
      ...(code ? { code } : {}),
      statusCode: status,
      error: title,
      message,
      path: request.url,
      method: request.method,
      timestamp: new Date().toISOString(),
    };

    response
      .status(status)
      .setHeader('x-request-id', requestId)
      .setHeader('content-type', 'application/problem+json; charset=utf-8')
      .send(JSON.stringify(body));
  }
}
