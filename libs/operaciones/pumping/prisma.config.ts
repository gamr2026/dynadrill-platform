import { config } from 'dotenv';
import { defineConfig } from 'prisma/config';

// Los scripts npm ejecutan este comando desde la carpeta del módulo; el .env vive en la app.
config({ path: ['../../../apps/operaciones/.env', '../../../.env'], quiet: true });

/**
 * dyn_migrator, directo a PostgreSQL (nunca por PgBouncer). `?schema=` ubica la tabla de historial de
 * migraciones de Prisma dentro del schema de ESTE módulo; se fuerza aquí porque la variable compartida
 * puede traer el de otro módulo.
 */
function urlDeMigracion(): string {
  const raw = process.env['DATABASE_URL_MIGRATOR'];
  if (!raw) return '';
  const url = new URL(raw);
  url.searchParams.set('schema', 'pumping');
  return url.toString();
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: urlDeMigracion() },
});
