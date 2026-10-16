import { z } from 'zod';
import { baseEnvSchema, defineEnv, jwtVerifyEnvSchema } from '@dyn/config';

const url = z.string().url();

/**
 * Un contenedor sin URL no recibe tráfico: sus rutas siguen en `demo-legacy`. Así cada módulo se
 * conmuta a la implementación nueva (agregando su URL) cuando supera su criterio de salida.
 */
export const gatewayEnvSchema = defineEnv(
  baseEnvSchema,
  jwtVerifyEnvSchema,
  z.object({
    LEGACY_URL: url,
    /**
     * TRANSICIÓN: secreto HS256 del backend demo (su JWT_SECRET). Si está definido, el gateway traduce
     * el token nuevo (RS256) a uno que la demo acepte al enrutar hacia ella. Sin él, el token pasa tal cual.
     */
    LEGACY_JWT_SECRET: z.string().min(16).optional(),
    PLATAFORMA_URL: url.optional(),
    COMERCIAL_URL: url.optional(),
    OPERACIONES_URL: url.optional(),
    QHSE_URL: url.optional(),
    RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(600),
    /** Más estricto que el general: frena la fuerza bruta de contraseñas por IP. */
    LOGIN_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(10),
    PROXY_TIMEOUT_MS: z.coerce.number().int().min(1000).default(60_000),
  }),
);

export type GatewayEnv = z.infer<typeof gatewayEnvSchema>;
