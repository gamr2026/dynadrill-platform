import { z } from 'zod';
import {
  baseEnvSchema,
  databaseEnvSchema,
  defineEnv,
  jwtVerifyEnvSchema,
  rabbitEnvSchema,
} from '@dyn/config';

/** El contenedor comercial solo VERIFICA tokens (clave pública); no los emite. */
export const comercialEnvSchema = defineEnv(
  baseEnvSchema,
  databaseEnvSchema,
  jwtVerifyEnvSchema,
  rabbitEnvSchema,
  z.object({
    /** Contenedor de plataforma: catálogos, directorio de personas y pedidos de AS2 (se consultan por su API). */
    PLATAFORMA_URL: z.string().url().default('http://localhost:3101'),
  }),
);

export type ComercialEnv = z.infer<typeof comercialEnvSchema>;
