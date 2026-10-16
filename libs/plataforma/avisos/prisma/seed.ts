/**
 * Siembra las plantillas y reglas de avisos (idempotente).
 *   npm run db:seed:avisos
 * Variables: DATABASE_URL (usuario app_plataforma).
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { loadDotenv } from '@dyn/config';
import { toPgConnectionString } from '@dyn/messaging';
import { sembrarPlantillas } from '../src/catalog/sembrar-plantillas';
import { PrismaClient } from '../src/generated/client';

loadDotenv('apps/plataforma/.env', '.env');

async function main() {
  const prisma = new PrismaClient({
    adapter: new PrismaPg(
      { connectionString: toPgConnectionString(process.env['DATABASE_URL'] as string) },
      { schema: 'avisos' },
    ),
  });
  try {
    const r = await sembrarPlantillas(prisma);
    console.log(`avisos: ${r.plantillas} plantillas y ${r.reglas} reglas nuevas`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
