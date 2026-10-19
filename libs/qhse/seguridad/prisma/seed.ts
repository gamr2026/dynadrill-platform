/**
 * Siembra los catálogos de QHSE (idempotente).
 *   npm run db:seed:qhse
 * Variables: DATABASE_URL (usuario app_qhse).
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { loadDotenv } from '@dyn/config';
import { toPgConnectionString } from '@dyn/messaging';
import { sembrarEpi } from '../src/catalog/sembrar-epi';
import { PrismaClient } from '../src/generated/client';

loadDotenv('apps/qhse/.env', '.env');

async function main() {
  const prisma = new PrismaClient({
    adapter: new PrismaPg(
      { connectionString: toPgConnectionString(process.env['DATABASE_URL'] as string) },
      { schema: 'qhse' },
    ),
  });
  try {
    const r = await sembrarEpi(prisma);
    console.log(`qhse: ${r.tallas} tallas de EPI nuevas`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
