import { z } from 'zod';
import { baseEnvSchema, defineEnv, jwtVerifyEnvSchema } from '@dyn/config';

const url = z.string().url();

/** Un contenedor sin URL no recibe tráfico: sus rutas responden 404. */
export const gatewayEnvSchema = defineEnv(
  baseEnvSchema,
  jwtVerifyEnvSchema,
  z.object({
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
