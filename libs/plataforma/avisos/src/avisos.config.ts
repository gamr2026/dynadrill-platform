import { z } from 'zod';

/**
 * Variables del módulo de avisos. `MAIL_REDIRECT_TO` es OBLIGATORIA: mientras el proyecto esté en pruebas todos los correos
 * llegan solo a esa dirección. Sin ella el contenedor no arranca (así nunca puede salir un correo a otra persona).
 * Por defecto el SMTP es el de Mailpit (desarrollo): captura los correos sin entregarlos. Para que lleguen a la bandeja real
 * se configura el SMTP de la organización en `apps/plataforma/.env` (host, usuario y clave: nunca en el repositorio).
 */
export const avisosEnvSchema = z.object({
  MAIL_REDIRECT_TO: z.string().email(),
  MAIL_FROM: z.string().min(3).default('Dynadrill <avisos@dynadrill.local>'),
  SMTP_HOST: z.string().default('localhost'),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(1025),
  SMTP_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  APP_URL: z.string().url().default('http://localhost:4200'),
});

export type AvisosEnv = z.infer<typeof avisosEnvSchema>;
