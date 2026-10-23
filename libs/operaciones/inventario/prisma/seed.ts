/**
 * Siembra los catálogos de Inventario: los motivos de movimiento (idempotente). Las unidades de medida son de la plataforma: `db:seed:catalogos`.
 *   npm run db:seed:inventario
 * Variables: DATABASE_URL (usuario app_operaciones). El catálogo de artículos se carga aparte: `npm run db:cargar:inventario`.
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { loadDotenv } from '@dyn/config';
import { toPgConnectionString } from '@dyn/messaging';
import { marcarCategoriasBase, sembrarCatalogos } from '../src/catalog/sembrar-catalogos';
import { PrismaClient } from '../src/generated/client';

loadDotenv('apps/operaciones/.env', '.env');

async function main() {
  const prisma = new PrismaClient({
    adapter: new PrismaPg(
      { connectionString: toPgConnectionString(process.env['DATABASE_URL'] as string) },
      { schema: 'inventario' },
    ),
  });
  try {
    const r = await sembrarCatalogos(prisma);
    await marcarCategoriasBase(prisma);
    console.log(`inventario: ${r.motivos} motivos de movimiento nuevos`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
