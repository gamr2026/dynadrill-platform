import { z } from 'zod';
import { jwtSignEnvSchema } from '@dyn/config';

/**
 * Variables que lee el módulo de identidad (además de DATABASE_URL, que valida la app).
 * `jwtSignEnvSchema` aporta JWT_PRIVATE_KEY y los tiempos de vida de los tokens.
 */
export const identidadEnvSchema = jwtSignEnvSchema.extend({
  JWT_ISSUER: z.string().default('dynadrill-plataforma'),
  /** Intentos fallidos consecutivos antes de bloquear la cuenta. */
  LOGIN_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(5),
  LOGIN_LOCK_MINUTES: z.coerce.number().int().min(1).default(15),
  /** `POST /auth/switch-role`: solo demos del flujo de Pumping. En producción debe estar en false. */
  DEV_ROLE_SWITCH: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  /**
   * La conexión con AS2 (URL, autenticación, llamadas) ya no se configura aquí: vive en la base de datos, en el
   * módulo `integraciones`. Solo queda cuándo y cómo se sincroniza.
   */
  /** Cada cuántos minutos sincronizar solo; 0 = únicamente a pedido (`POST /as2/sincronizar`). */
  AS2_SYNC_INTERVAL_MINUTES: z.coerce.number().int().min(0).default(0),
  /** Inactivar las cuentas del portal cuyo empleado de AS2 ya tiene fecha de salida. Apagado por defecto. */
  AS2_SYNC_INACTIVAR_BAJAS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

export type IdentidadEnv = z.infer<typeof identidadEnvSchema>;
