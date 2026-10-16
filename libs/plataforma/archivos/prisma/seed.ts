/**
 * Siembra los módulos que guardan archivos (idempotente).
 *   npm run db:seed:archivos
 * Variables: DATABASE_URL (usuario app_plataforma).
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { loadDotenv } from '@dyn/config';
import { toPgConnectionString } from '@dyn/messaging';
import { sembrarModulosArchivo } from '../src/catalog/sembrar-modulos';
import { PrismaClient } from '../src/generated/client';

loadDotenv('apps/plataforma/.env', '.env');

async function main() {
  const prisma = new PrismaClient({
    adapter: new PrismaPg(
      { connectionString: toPgConnectionString(process.env['DATABASE_URL'] as string) },
      { schema: 'archivos' },
    ),
  });
  try {
    console.log(`módulos de archivos nuevos: ${await sembrarModulosArchivo(prisma)}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
