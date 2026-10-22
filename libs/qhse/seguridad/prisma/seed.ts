/**
 * Siembra los catálogos de QHSE (idempotente).
 *   npm run db:seed:qhse
 * Variables: DATABASE_URL (usuario app_qhse).
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { loadDotenv } from '@dyn/config';
import { toPgConnectionString } from '@dyn/messaging';
import { sembrarEpi } from '../src/catalog/sembrar-epi';
import { sembrarInvestigacion } from '../src/catalog/sembrar-investigacion';
import { sembrarRequisitosLegales } from '../src/catalog/sembrar-requisitos-legales';
import { sembrarStopEInspecciones } from '../src/catalog/sembrar-stop-inspecciones';
import { sembrarSwa } from '../src/catalog/sembrar-swa';
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
    const stop = await sembrarStopEInspecciones(prisma);
    console.log(
      `qhse: STOP con ${stop.subcategorias} subcategorías y ${stop.items} ítems nuevos; inspecciones con ${stop.tipos} tipos y ${stop.criterios} criterios nuevos`,
    );
    const swa = await sembrarSwa(prisma);
    console.log(
      `qhse: SWA con ${swa.tipos} tipos de peligro, ${swa.roles} roles de la cadena y ${swa.criterios} criterios de reinicio nuevos`,
    );
    const inv = await sembrarInvestigacion(prisma);
    console.log(
      `qhse: investigación con ${inv.resultados} resultados de incidente y ${inv.categorias} categorías de Ishikawa nuevos`,
    );
    const legal = await sembrarRequisitosLegales(prisma);
    console.log(`qhse: requisitos legales con ${legal.tipos} tipos nuevos`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
