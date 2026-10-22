/**
 * Siembra los catálogos de firmas: documentos firmables y papeles de quien firma (idempotente).
 *   npm run db:seed:firmas
 * Variables: DATABASE_URL (usuario app_plataforma).
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { loadDotenv } from '@dyn/config';
import { toPgConnectionString } from '@dyn/messaging';
import { sembrarCatalogos } from '../src/catalog/sembrar-catalogos';
import { PrismaClient } from '../src/generated/client';

loadDotenv('apps/plataforma/.env', '.env');

async function main() {
  const prisma = new PrismaClient({
    adapter: new PrismaPg(
      { connectionString: toPgConnectionString(process.env['DATABASE_URL'] as string) },
      { schema: 'firmas' },
    ),
  });
  try {
    const r = await sembrarCatalogos(prisma);
    console.log(`firmas: ${r.documentos} documento(s) y ${r.roles} papel(es) nuevos`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
