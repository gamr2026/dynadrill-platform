/**
 * Siembra los pasos, transiciones, requisitos y catálogos de FCR (idempotente).
 *   npm run db:seed:fcr
 * Variables: DATABASE_URL (usuario app_operaciones). Requiere los roles de identidad (npm run db:seed:identidad).
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { loadDotenv } from '@dyn/config';
import { toPgConnectionString } from '@dyn/messaging';
import { sembrarPasos } from '../src/catalog/sembrar-pasos';
import { PrismaClient } from '../src/generated/client';

loadDotenv('apps/operaciones/.env', '.env');

async function main() {
  const prisma = new PrismaClient({
    adapter: new PrismaPg(
      { connectionString: toPgConnectionString(process.env['DATABASE_URL'] as string) },
      { schema: 'fcr' },
    ),
  });
  try {
    const r = await sembrarPasos(prisma);
    console.log(
      `fcr: ${r.pasos} pasos, ${r.transiciones} transiciones, ${r.requisitos} requisitos y ${r.catalogos} elementos de catálogo nuevos`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
