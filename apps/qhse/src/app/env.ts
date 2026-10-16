import { z } from 'zod';
import {
  baseEnvSchema,
  databaseEnvSchema,
  defineEnv,
  jwtVerifyEnvSchema,
  rabbitEnvSchema,
} from '@dyn/config';

/** El contenedor qhse solo VERIFICA tokens (clave pública); no los emite. */
export const qhseEnvSchema = defineEnv(
  baseEnvSchema,
  databaseEnvSchema,
  jwtVerifyEnvSchema,
  rabbitEnvSchema,
);

export type QhseEnv = z.infer<typeof qhseEnvSchema>;
