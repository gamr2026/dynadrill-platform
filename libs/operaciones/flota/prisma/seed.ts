/**
 * Siembra las reglas del mantenimiento preventivo, los proveedores y las unidades iniciales de Flota (idempotente).
 *   npm run db:seed:flota
 * Variables: DATABASE_URL (usuario app_operaciones).
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { loadDotenv } from '@dyn/config';
import { toPgConnectionString } from '@dyn/messaging';
import { sembrarFlota } from '../src/catalog/sembrar-flota';
import { PrismaClient } from '../src/generated/client';

loadDotenv('apps/operaciones/.env', '.env');

async function main() {
  const prisma = new PrismaClient({
    adapter: new PrismaPg(
      { connectionString: toPgConnectionString(process.env['DATABASE_URL'] as string) },
      { schema: 'flota' },
    ),
  });
  try {
    const r = await sembrarFlota(prisma);
    console.log(
      `flota: ${r.reglas} reglas preventivas, ${r.proveedores} proveedores, ${r.unidades} unidades, ` +
        `${r.tiposPermiso} tipos de documento de conductor y ${r.itemsInspeccion} ítems de inspección nuevos`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
