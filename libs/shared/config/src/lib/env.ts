import { z } from 'zod';

/**
 * Esquemas de variables de entorno componibles. Cada contenedor arma el suyo con
 * `defineEnv(base, database, jwtVerify, ...)`; si falta algo obligatorio o es inválido,
 * el proceso NO arranca (documento de arquitectura, cap. 10: configuración validada).
 */
export const baseEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  SERVICE_NAME: z.string().min(1),
  PORT: z.coerce.number().int().min(1).max(65535),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** Orígenes permitidos por CORS, separados por coma. */
  CORS_ORIGIN: z.string().default('http://localhost:4200'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
});

/** Conexión de la aplicación (usuario `app_*`, normalmente a través de PgBouncer). */
export const databaseEnvSchema = z.object({
  DATABASE_URL: z
    .string()
    .regex(/^postgres(ql)?:\/\//, 'DATABASE_URL debe ser una URL de PostgreSQL'),
});

/** Verificación de tokens con la clave pública (RS256); todos los contenedores la usan. */
export const jwtVerifyEnvSchema = z.object({
  JWT_PUBLIC_KEY: z.string().min(1, 'JWT_PUBLIC_KEY es obligatoria (PEM)'),
  JWT_ISSUER: z.string().default('dynadrill-plataforma'),
});

/** Firma de tokens: solo el módulo de identidad (contenedor plataforma). */
export const jwtSignEnvSchema = z.object({
  JWT_PRIVATE_KEY: z.string().min(1, 'JWT_PRIVATE_KEY es obligatoria (PEM)'),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().min(60).default(900),
  JWT_REFRESH_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(300)
    .default(60 * 60 * 24 * 7),
});

export const rabbitEnvSchema = z.object({
  RABBITMQ_URL: z.string().regex(/^amqps?:\/\//, 'RABBITMQ_URL debe ser una URL amqp(s)'),
  OUTBOX_RELAY_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  OUTBOX_RELAY_INTERVAL_MS: z.coerce.number().int().min(50).default(1000),
});

type AnyObject = z.ZodObject<z.ZodRawShape>;

/** Convierte una unión de formas en su intersección: `{a} | {b}` → `{a} & {b}`. */
type UnionToIntersection<U> = (U extends unknown ? (x: U) => void : never) extends (
  x: infer I,
) => void
  ? I
  : never;

/** Une varios esquemas en uno conservando el tipo de cada variable. */
export function defineEnv<T extends AnyObject[]>(
  ...schemas: T
): UnionToIntersection<T[number]['shape']> extends infer S extends z.ZodRawShape
  ? z.ZodObject<S>
  : never {
  return schemas.reduce<AnyObject>((acc, s) => acc.extend(s.shape), z.object({})) as never;
}

export class EnvValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Configuración inválida:\n - ${issues.join('\n - ')}`);
    this.name = 'EnvValidationError';
  }
}

/** Valida y tipa `process.env` (o el objeto dado). Lanza con TODOS los problemas a la vez. */
export function validateEnv<S extends z.ZodTypeAny>(
  schema: S,
  raw: Record<string, unknown> = process.env,
): z.infer<S> {
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new EnvValidationError(
      result.error.issues.map((i) => `${i.path.join('.') || '(raíz)'}: ${i.message}`),
    );
  }
  return result.data;
}

/** Las claves PEM suelen llegar con `\n` literales desde .env o Key Vault. */
export function normalizePem(value: string): string {
  return value.includes('\\n') ? value.replace(/\\n/g, '\n') : value;
}

export function parseCorsOrigins(value: string): string[] {
  return value
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}

/**
 * Carga archivos `.env` (el primero que define una variable gana; nunca pisa el entorno real).
 * Se llama antes de iniciar el tracing, que necesita `OTEL_EXPORTER_OTLP_ENDPOINT`.
 */
export function loadDotenv(...paths: string[]): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { config } = require('dotenv') as typeof import('dotenv');
  for (const path of paths) config({ path, quiet: true });
}
