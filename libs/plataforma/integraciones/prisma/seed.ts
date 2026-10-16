/**
 * Siembra la configuración inicial de AS2 (idempotente; si ya existe no la toca).
 *   npm run db:seed:integraciones
 * Variables: DATABASE_URL (usuario app_plataforma) y, opcionalmente, AS2_BASE_URL (p. ej.
 * http://host:8020/AS2) y AS2_ID_ORGANIZACION. Sin AS2_BASE_URL el proveedor queda inactivo.
 * Los secretos (AS2_USER, AS2_PASSWORD) NO se guardan en la base: el motor los lee del entorno al ejecutar.
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { loadDotenv } from '@dyn/config';
import { toPgConnectionString } from '@dyn/messaging';
import { sembrarAs2 } from '../src/catalog/sembrar-as2';
import { sembrarAs2Pedidos } from '../src/catalog/sembrar-as2-pedidos';
import { sembrarAs2Pedidos } from '../src/catalog/sembrar-as2-pedidos';
import { PrismaClient } from '../src/generated/client';

loadDotenv('apps/plataforma/.env', '.env');

async function main() {
  const prisma = new PrismaClient({
    adapter: new PrismaPg(
      { connectionString: toPgConnectionString(process.env['DATABASE_URL'] as string) },
      { schema: 'integraciones' },
    ),
  });
  try {
    const base = process.env['AS2_BASE_URL']?.replace(/\/+$/, '');
    const creado = await sembrarAs2(prisma, {
      baseUrl: base ? `${base}/rest` : undefined,
      idOrganizacion: Number(process.env['AS2_ID_ORGANIZACION'] ?? 1),
    });
    console.log(
      creado
        ? `proveedor as2 creado (${base ? 'activo' : 'inactivo: falta AS2_BASE_URL'})`
        : 'proveedor as2 ya existía: no se modificó',
    );
    const nuevas = await sembrarAs2Pedidos(prisma);
    console.log(`operaciones de pedidos de as2 creadas: ${nuevas}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
