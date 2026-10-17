/**
 * Siembra los catálogos de Mantenimiento: tipos y estados de sub-orden, transiciones y el contador del reporte (idempotente).
 *   npm run db:seed:mantenimiento
 * Variables: DATABASE_URL (usuario app_operaciones).
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { loadDotenv } from '@dyn/config';
import { toPgConnectionString } from '@dyn/messaging';
import { sembrarCatalogos } from '../src/catalog/sembrar-catalogos';
import { PrismaClient } from '../src/generated/client';

loadDotenv('apps/operaciones/.env', '.env');

async function main() {
  const prisma = new PrismaClient({
    adapter: new PrismaPg(
      { connectionString: toPgConnectionString(process.env['DATABASE_URL'] as string) },
      { schema: 'mantenimiento' },
    ),
  });
  try {
    const r = await sembrarCatalogos(prisma);
    console.log(
      `mantenimiento: ${r.tipos} tipos, ${r.estados} estados y ${r.transiciones} transiciones de sub-orden nuevos`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
