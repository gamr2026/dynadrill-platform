import { z } from 'zod';
import {
  baseEnvSchema,
  databaseEnvSchema,
  defineEnv,
  jwtVerifyEnvSchema,
  rabbitEnvSchema,
} from '@dyn/config';
import { archivosEnvSchema } from '@dyn/archivos';
import { avisosEnvSchema } from '@dyn/avisos';
import { identidadEnvSchema } from '@dyn/identidad';

export const plataformaEnvSchema = defineEnv(
  baseEnvSchema,
  databaseEnvSchema,
  jwtVerifyEnvSchema,
  rabbitEnvSchema,
  identidadEnvSchema,
  archivosEnvSchema,
  avisosEnvSchema,
  // Módulo de diagnóstico (F0): sirve para probar outbox → RabbitMQ → inbox y las trazas.
  // Se retira cuando exista el primer flujo real; nunca se activa en producción.
  z.object({
    DIAGNOSTICO_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
  }),
);

export type PlataformaEnv = z.infer<typeof plataformaEnvSchema>;
