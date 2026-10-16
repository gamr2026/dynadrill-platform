/**
 * Migra las listas de precios de la demo (SQLite, solo lectura) a `comercial` (PostgreSQL). Idempotente.
 *   npm run db:migrate-demo:comercial                       (usa DEMO_DB_PATH o la ruta por defecto)
 *
 * - Cada lista conserva su id numérico en `legacy_id`; una lista ya migrada NO se toca (ni sus ítems).
 * - El cliente se enlaza por el `legacy_id` de `catalogos.cliente` (por eso se usa DATABASE_URL_MIGRATOR, que puede
 *   leer ese schema; `app_comercial` no puede). Si no se encuentra, la lista se migra igual con el nombre.
 * - Los códigos repetidos dentro de una misma lista se reportan y se conserva el último (como hacía la demo).
 * - Imprime un informe; no escribe nada fuera del schema `comercial`.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { loadDotenv } from '@dyn/config';
import { toPgConnectionString } from '@dyn/messaging';
import { uuidv7 } from '@dyn/utils';
import { PrismaClient } from '../src/generated/client';

loadDotenv('apps/plataforma/.env', '.env');

type Row = Record<string, unknown>;

async function main() {
  const dbPath = resolve(process.env['DEMO_DB_PATH'] ?? '../dynadrill-backend/prisma/dynadrill.db');
  if (!existsSync(dbPath)) throw new Error(`No existe la base de la demo: ${dbPath}`);
  const url = process.env['DATABASE_URL_MIGRATOR'];
  if (!url) throw new Error('DATABASE_URL_MIGRATOR es obligatoria');

  const demo = new DatabaseSync(dbPath, { readOnly: true });
  const prisma = new PrismaClient({
    adapter: new PrismaPg(
      { connectionString: toPgConnectionString(url), max: 2 },
      { schema: 'comercial' },
    ),
  });

  try {
    const listas = demo.prepare('SELECT * FROM listas_precios ORDER BY id').all() as Row[];
    const clientes = await prisma.$queryRaw<Array<{ id: string; legacy_id: number | null }>>`
      SELECT id::text AS id, legacy_id FROM catalogos.cliente WHERE legacy_id IS NOT NULL`;
    const clientePorLegacy = new Map(clientes.map((c) => [c.legacy_id as number, c.id]));
    const yaMigradas = new Set(
      (await prisma.listaPrecios.findMany({ select: { legacyId: true } })).map((l) => l.legacyId),
    );

    let creadas = 0;
    let existentes = 0;
    let sinCliente = 0;
    let items = 0;
    const repetidos: string[] = [];

    for (const l of listas) {
      const legacyId = Number(l['id']);
      if (yaMigradas.has(legacyId)) {
        existentes++;
        continue;
      }
      const clienteId =
        l['clienteId'] === null ? null : (clientePorLegacy.get(Number(l['clienteId'])) ?? null);
      if (!clienteId) sinCliente++;

      const filas = demo
        .prepare('SELECT * FROM lista_precios_items WHERE listaPreciosId = ? ORDER BY id')
        .all(legacyId) as Row[];
      const porCodigo = new Map<string, Row>();
      for (const f of filas) {
        const codigo = String(f['codigo']).trim();
        if (porCodigo.has(codigo)) repetidos.push(`lista ${legacyId}: ${codigo}`);
        porCodigo.set(codigo, f);
      }

      const id = uuidv7();
      await prisma.$transaction(async (tx) => {
        await tx.listaPrecios.create({
          data: {
            id,
            legacyId,
            clienteId,
            numeroContrato: String(l['numeroContrato'] ?? '').trim() || 'S/N',
            vigenteDesde: new Date(Number(l['vigenteDesde']) || String(l['vigenteDesde'])),
            // sin cliente enlazado (p. ej. la lista de referencia interna) queda inactiva: ningún pedido la usaría
            activa: Number(l['activa']) === 1 && clienteId !== null,
          },
        });
        const datos = [...porCodigo.entries()].map(([codigo, f]) => ({
          id: uuidv7(),
          listaPreciosId: id,
          codigo,
          descripcion: String(f['descripcion'] ?? '').trim() || codigo,
          unidad: String(f['unidad'] ?? '').trim() || 'UND',
          precio: Number(f['precio']),
          tipo: String(f['tipo'] ?? 'Servicio'),
        }));
        for (let i = 0; i < datos.length; i += 500) {
          await tx.listaPreciosItem.createMany({ data: datos.slice(i, i + 500) });
        }
        items += datos.length;
      });
      creadas++;
    }

    console.log(
      `listas en la demo: ${listas.length} | creadas: ${creadas} | ya migradas: ${existentes} | sin cliente enlazado: ${sinCliente} | ítems creados: ${items}`,
    );
    if (repetidos.length)
      console.log(
        `códigos repetidos (se conservó el último): ${repetidos.length}`,
        repetidos.slice(0, 10),
      );
  } finally {
    demo.close();
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
