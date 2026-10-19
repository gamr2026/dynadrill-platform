/**
 * Normaliza los códigos de artículo que tienen espacios (el alta de artículos no los admite): se guardan sin espacios y el código
 * original queda como equivalencia (motivo `formato`), para conciliar con AS2 por cualquiera de los dos.
 *   npm run db:normalizar:codigos
 * Idempotente. Si el código normalizado ya es de otro artículo (el de AS2 que no tenía espacios), el normalizado recibe el sufijo
 * `-2`, `-3`...: el artículo cuyo código ya era limpio conserva el suyo.
 * Orden de carga: `db:cargar:inventario`, `db:cargar:epp`, `db:cargar:bienes` y al final este.
 *
 * Variable: DATABASE_URL (usuario app_operaciones).
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { loadDotenv } from '@dyn/config';
import { toPgConnectionString } from '@dyn/messaging';
import { uuidv7 } from '@dyn/utils';
import { normalizarCodigo, tieneEspacios } from '../src/catalog/codigos';
import { PrismaClient } from '../src/generated/client';

loadDotenv('apps/operaciones/.env', '.env');

export async function normalizarCodigos(
  prisma: PrismaClient,
): Promise<{ normalizados: number; conSufijo: number }> {
  const todos = await prisma.articulo.findMany({ select: { id: true, codigo: true } });
  const usados = new Set(todos.map((a) => a.codigo.toUpperCase()));
  const pendientes = todos
    .filter((a) => tieneEspacios(a.codigo))
    .sort((a, b) => a.codigo.localeCompare(b.codigo));
  let conSufijo = 0;
  for (const a of pendientes) {
    const base = normalizarCodigo(a.codigo);
    let nuevo = base;
    let n = 1;
    while (usados.has(nuevo.toUpperCase())) {
      n += 1;
      nuevo = `${base}-${n}`;
    }
    if (nuevo !== base) conSufijo++;
    await prisma.$transaction(async (tx) => {
      await tx.articulo.update({ where: { id: a.id }, data: { codigo: nuevo } });
      await tx.articuloEquivalencia.create({
        data: { id: uuidv7(), articuloId: a.id, codigo: a.codigo, motivo: 'formato' },
      });
    });
    usados.delete(a.codigo.toUpperCase());
    usados.add(nuevo.toUpperCase());
  }
  return { normalizados: pendientes.length, conSufijo };
}

async function main() {
  const prisma = new PrismaClient({
    adapter: new PrismaPg(
      { connectionString: toPgConnectionString(process.env['DATABASE_URL'] as string) },
      { schema: 'inventario' },
    ),
  });
  try {
    const r = await normalizarCodigos(prisma);
    console.log(`Códigos normalizados: ${r.normalizados} (${r.conSufijo} con sufijo por colisión)`);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
