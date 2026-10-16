import { z } from 'zod';

/**
 * Configuración del almacenamiento y del antivirus. Por defecto: Azurite local y sin antivirus (solo desarrollo).
 * En producción: `ARCHIVOS_STORAGE_CONNECTION_STRING` de Azure Blob Storage y `ARCHIVOS_SCANNER=clamav`.
 */
export const archivosEnvSchema = z.object({
  ARCHIVOS_STORAGE_CONNECTION_STRING: z.string().default('UseDevelopmentStorage=true'),
  ARCHIVOS_CONTAINER: z.string().min(3).default('archivos'),
  ARCHIVOS_SCANNER: z.enum(['none', 'clamav']).default('none'),
  CLAMAV_HOST: z.string().default('localhost'),
  CLAMAV_PORT: z.coerce.number().int().default(3310),
  /** Servicio de lectura de firmas (`apps/firmas-ocr`). Sin URL, la verificación de firmas no está disponible. */
  FIRMAS_OCR_URL: z.string().url().optional(),
  FIRMAS_OCR_API_KEY: z.string().optional(),
  FIRMAS_OCR_TIMEOUT_MS: z.coerce.number().int().default(70_000),
});

export type ArchivosEnv = z.infer<typeof archivosEnvSchema>;
