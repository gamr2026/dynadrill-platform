import { config } from 'dotenv';
import { defineConfig } from 'prisma/config';

// Los scripts npm ejecutan este comando desde la carpeta del módulo; el .env vive en la app.
config({ path: ['../../../apps/plataforma/.env', '../../../.env'], quiet: true });

/** Fuerza el schema de este módulo: la variable compartida puede traer el de otro. */
function urlDeMigracion(): string {
  const raw = process.env['DATABASE_URL_MIGRATOR'];
  if (!raw) return '';
  const url = new URL(raw);
  url.searchParams.set('schema', 'identidad');
  return url.toString();
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  // dyn_migrator, directo a PostgreSQL (nunca por PgBouncer). El parámetro `schema` ubica la tabla de
  // historial de migraciones dentro del schema del módulo, para que los módulos no compartan historial.
  datasource: { url: urlDeMigracion() },
});
