/**
 * Siembra los pasos del servicio de Pumping (idempotente).
 *   npm run db:seed:pumping
 * Variables: DATABASE_URL (usuario app_operaciones).
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { loadDotenv } from '@dyn/config';
import { toPgConnectionString } from '@dyn/messaging';
import { sembrarPasos } from '../src/catalog/sembrar-pasos';
import { sembrarTrasladoSalida } from '../src/catalog/sembrar-traslado-salida';
import { PrismaClient } from '../src/generated/client';

loadDotenv('apps/operaciones/.env', '.env');

async function main() {
  const prisma = new PrismaClient({
    adapter: new PrismaPg(
      { connectionString: toPgConnectionString(process.env['DATABASE_URL'] as string) },
      { schema: 'pumping' },
    ),
  });
  try {
    const r = await sembrarPasos(prisma);
    console.log(`pumping: ${r.pasos} pasos y ${r.transiciones} transiciones nuevos`);
    const t = await sembrarTrasladoSalida(prisma);
    console.log(
      `pumping: ${t.requisitos} requisitos y ${t.items} elementos de catálogo nuevos (términos, gases, LOTO, inspección)`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
