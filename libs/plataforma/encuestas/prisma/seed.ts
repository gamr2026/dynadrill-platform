/**
 * Siembra los módulos con encuestas, la escala de satisfacción y la encuesta genérica de FCR (idempotente).
 *   npm run db:seed:encuestas
 * Variables: DATABASE_URL (usuario app_plataforma). La versión inicial queda publicada a nombre del primer Superadmin activo;
 * si todavía no hay ninguno, queda en borrador y la administración la publica.
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { loadDotenv } from '@dyn/config';
import { toPgConnectionString } from '@dyn/messaging';
import { sembrarEncuestas } from '../src/catalog/sembrar-encuestas';
import { PrismaClient } from '../src/generated/client';

loadDotenv('apps/plataforma/.env', '.env');

async function main() {
  const prisma = new PrismaClient({
    adapter: new PrismaPg(
      { connectionString: toPgConnectionString(process.env['DATABASE_URL'] as string) },
      { schema: 'encuestas' },
    ),
  });
  try {
    // `identidad` es de otro módulo: se lee con SQL directo (solo el id de una cuenta, para el rastro de quién publicó)
    const filas = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT u.id FROM identidad.usuario u JOIN identidad.rol r ON r.id = u.rol_id
      WHERE r.codigo = 'superadmin' AND u.activo ORDER BY u.id LIMIT 1`;
    const r = await sembrarEncuestas(prisma, filas[0]?.id ?? null);
    console.log(
      `encuestas: ${r.modulos} módulos, ${r.escalas} escalas y ${r.encuestas} encuestas nuevas` +
        (r.encuestas && !r.publicada
          ? ' (la versión 1 queda en borrador: no hay un Superadmin)'
          : ''),
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
