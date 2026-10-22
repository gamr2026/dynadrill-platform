/**
 * Siembra la lista blanca de claves de auditoría (idempotente).
 *   npm run db:seed:auditoria
 * Variables: DATABASE_URL (usuario app_plataforma).
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { loadDotenv } from '@dyn/config';
import { toPgConnectionString } from '@dyn/messaging';
import { sembrarClaves } from '../src/catalog/sembrar-claves';
import { PrismaClient } from '../src/generated/client';

loadDotenv('apps/plataforma/.env', '.env');

async function main() {
  const prisma = new PrismaClient({
    adapter: new PrismaPg(
      { connectionString: toPgConnectionString(process.env['DATABASE_URL'] as string) },
      { schema: 'auditoria' },
    ),
  });
  try {
    console.log(`auditoria: ${await sembrarClaves(prisma)} clave(s) nueva(s)`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
