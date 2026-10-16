/**
 * Siembra los catálogos compartidos que vienen de AS2 (bodegas y condiciones de pago). Idempotente.
 *   npm run db:seed:catalogos
 * Variables: DATABASE_URL (usuario app_plataforma).
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { loadDotenv } from '@dyn/config';
import { toPgConnectionString } from '@dyn/messaging';
import { sembrarComercial } from '../src/catalog/sembrar-comercial';
import { sembrarTransporte } from '../src/catalog/sembrar-transporte';
import { PrismaClient } from '../src/generated/client';

loadDotenv('apps/plataforma/.env', '.env');

async function main() {
  const prisma = new PrismaClient({
    adapter: new PrismaPg(
      { connectionString: toPgConnectionString(process.env['DATABASE_URL'] as string) },
      { schema: 'catalogos' },
    ),
  });
  try {
    const r = await sembrarComercial(prisma);
    console.log(`bodegas nuevas: ${r.bodegas} | condiciones de pago nuevas: ${r.condiciones}`);
    const t = await sembrarTransporte(prisma);
    console.log(
      `transporte nuevo: ${t.transportistas} transportistas, ${t.tipos} tipos de vehículo, ${t.vehiculos} vehículos, ${t.choferes} choferes`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
