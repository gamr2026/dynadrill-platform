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
    /** Contenedor de operaciones: documentos del ticket, reportes de unidad, inspecciones, viajes y órdenes de mantenimiento (expediente). */
    OPERACIONES_URL: z.string().url().default('http://localhost:3103'),
    /** Contenedor de QHSE: documentos del pedido para el expediente. */
    QHSE_URL: z.string().url().default('http://localhost:3104'),
  }),
);

export type ComercialEnv = z.infer<typeof comercialEnvSchema>;
