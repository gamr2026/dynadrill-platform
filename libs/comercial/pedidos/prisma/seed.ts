/**
 * Siembra los documentos y secuenciales iniciales del ciclo comercial (idempotente; si ya existen no se tocan).
 *   npm run db:seed:comercial
 * Variables: DATABASE_URL (usuario app_comercial) y, opcionalmente, SEED_ULTIMO_CODIGO_PEDIDO y SEED_ULTIMO_PEC_AS2.
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { loadDotenv } from '@dyn/config';
import { toPgConnectionString } from '@dyn/messaging';
import { sembrarDocumentos } from '../src/catalog/sembrar-documentos';
import { sembrarOrdenTrabajo } from '../src/catalog/sembrar-orden-trabajo';
import { sembrarTasas } from '../src/catalog/sembrar-tasas';
import { sembrarServicios } from '../src/catalog/sembrar-servicios';
import { sembrarWorkflowPedido } from '../src/catalog/sembrar-workflow-pedido';
import { PrismaClient } from '../src/generated/client';

loadDotenv('apps/comercial/.env', 'apps/plataforma/.env', '.env');

async function main() {
  const prisma = new PrismaClient({
    adapter: new PrismaPg(
      {
        connectionString: toPgConnectionString(
          process.env['DATABASE_URL_COMERCIAL'] ?? (process.env['DATABASE_URL'] as string),
        ),
      },
      { schema: 'comercial' },
    ),
  });
  try {
    const num = (v: string | undefined) => (v ? Number(v) : undefined);
    const creados = await sembrarDocumentos(prisma, {
      ultimoCodigoPedido: num(process.env['SEED_ULTIMO_CODIGO_PEDIDO']),
      ultimoPecAs2: num(process.env['SEED_ULTIMO_PEC_AS2']),
      ultimoPrcAs2: num(process.env['SEED_ULTIMO_PRC_AS2']),
      ultimaGuiaRemision: num(process.env['SEED_ULTIMA_GUIA_REMISION']),
      ultimaOrdenTrabajo: num(process.env['SEED_ULTIMA_OT']),
    });
    const ot = await sembrarOrdenTrabajo(prisma);
    console.log(
      `orden de trabajo: ${ot.ciudades} ciudades, ${ot.firmantes} firmantes y ${ot.listas} listas de precios actualizadas`,
    );
    const wf = await sembrarWorkflowPedido(prisma);
    console.log(`tasas de impuestos nuevas: ${await sembrarTasas(prisma)}`);
    const sv = await sembrarServicios(prisma);
    console.log(
      `servicios: ${sv.lineas} líneas, ${sv.tipos} tipos y ${sv.subtipos} subtipos nuevos`,
    );
    console.log(`proceso pedido: ${wf.estados} estados y ${wf.pasos} pasos nuevos`);
    console.log(
      creados.length
        ? `documentos creados: ${creados.join(', ')}`
        : 'los documentos ya existían: no se modificó nada',
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
