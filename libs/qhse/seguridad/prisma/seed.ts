/**
 * Siembra los catálogos de QHSE (idempotente).
 *   npm run db:seed:qhse
 * Variables: DATABASE_URL (usuario app_qhse).
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { loadDotenv } from '@dyn/config';
import { toPgConnectionString } from '@dyn/messaging';
import { sembrarDerrames } from '../src/catalog/sembrar-derrames';
import { sembrarDesechos } from '../src/catalog/sembrar-desechos';
import { sembrarEpi } from '../src/catalog/sembrar-epi';
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
    const des = await sembrarDesechos(prisma);
    console.log(
      `qhse: desechos con ${des.caracteristicas} características CRETIB, ${des.contenedores} contenedores y ${des.estados} estados nuevos`,
    );
    const der = await sembrarDerrames(prisma);
    console.log(
      `qhse: derrames con ${der.ubicaciones} ubicaciones, ${der.bandas} bandas de volumen y ${der.pasos} pasos de contención nuevos (bandas POR CONFIRMAR con Dynadrill)`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
