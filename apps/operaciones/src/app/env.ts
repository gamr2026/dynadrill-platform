import { z } from 'zod';
import {
  baseEnvSchema,
  databaseEnvSchema,
  defineEnv,
  jwtVerifyEnvSchema,
  rabbitEnvSchema,
} from '@dyn/config';

/** El contenedor operaciones solo VERIFICA tokens (clave pública); no los emite. */
export const operacionesEnvSchema = defineEnv(
  baseEnvSchema,
  databaseEnvSchema,
  jwtVerifyEnvSchema,
  rabbitEnvSchema,
  z.object({
    /** Contenedor de plataforma: catálogos y directorio de personas (se consultan por su API). */
    PLATAFORMA_URL: z.string().url().default('http://localhost:3101'),
  }),
);

export type OperacionesEnv = z.infer<typeof operacionesEnvSchema>;
