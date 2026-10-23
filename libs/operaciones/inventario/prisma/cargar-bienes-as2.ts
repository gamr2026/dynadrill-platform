/**
 * Carga de los bienes de AS2 que Inventario aún no tenía (químicos, completion, fishing y los repuestos y suministros de
 * mantenimiento), desde el reporte «Atributos por Producto» de AS2 ya depurado en `prisma/data/as2-bienes.json` (ver
 * `prisma/data/README.md`: normalización de códigos y colisiones).
 *   npm run db:cargar:bienes
 * Idempotente y sin pisar nada: un artículo que ya existe no se toca. No registra saldos: el reporte no trae existencias, costo ni bodega.
 * Un código de AS2 con espacios se guarda normalizado y el original queda como equivalencia (motivo `formato`).
 *
 * Variable: DATABASE_URL (usuario app_operaciones).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { loadDotenv } from '@dyn/config';
import { toPgConnectionString } from '@dyn/messaging';
import { uuidv7 } from '@dyn/utils';
import {
  CATEGORIAS_CON_PARTES,
  CATEGORIAS_QUIMICAS,
  CATEGORIAS_REPUESTOS,
  sembrarCatalogos,
  UNIDAD_POR_DEFECTO,
} from '../src/catalog/sembrar-catalogos';
import { PrismaClient } from '../src/generated/client';

loadDotenv('apps/operaciones/.env', '.env');

interface BienAs2 {
  codigo: string;
  codigoAs2: string | null;
  nombre: string;
  nombreComercial: string | null;
  categoria: string;
  subcategoria: string | null;
  nota: string | null;
}
interface ArchivoBienes {
  articulos: BienAs2[];
}

export interface ResumenBienes {
  categorias: number;
  subcategorias: number;
  articulos: number;
  yaExistian: number;
  equivalencias: number;
}

const LOTE = 200;

export async function cargarBienesAs2(prisma: PrismaClient): Promise<ResumenBienes> {
  await sembrarCatalogos(prisma);
  const datos = JSON.parse(
    readFileSync(join(__dirname, 'data', 'as2-bienes.json'), 'utf8'),
  ) as ArchivoBienes;
  const unidad = await prisma.catUnidadMedida.findUniqueOrThrow({
    where: { nombre: UNIDAD_POR_DEFECTO },
  });
  const r: ResumenBienes = {
    categorias: 0,
    subcategorias: 0,
    articulos: 0,
    yaExistian: 0,
    equivalencias: 0,
  };

  const categoriaId = new Map<string, string>();
  for (const nombre of new Set(datos.articulos.map((a) => a.categoria))) {
    let c = await prisma.categoriaArticulo.findUnique({ where: { nombre } });
    if (!c) {
      c = await prisma.categoriaArticulo.create({
        data: {
          id: uuidv7(),
          nombre,
          esQuimica: CATEGORIAS_QUIMICAS.includes(nombre),
          llevaPartes: CATEGORIAS_CON_PARTES.includes(nombre),
          esRepuesto: CATEGORIAS_REPUESTOS.includes(nombre),
        },
      });
      r.categorias++;
    }
    categoriaId.set(nombre, c.id);
  }
  const subcategoriaId = new Map<string, string>();
  for (const par of new Set(
    datos.articulos
      .filter((a) => a.subcategoria)
      .map((a) => `${a.categoria}\u0000${a.subcategoria}`),
  )) {
    const [cat, nombre] = par.split('\u0000');
    const catId = categoriaId.get(cat) as string;
    let s = await prisma.subcategoriaArticulo.findUnique({
      where: { categoriaId_nombre: { categoriaId: catId, nombre } },
    });
    if (!s) {
      s = await prisma.subcategoriaArticulo.create({
        data: { id: uuidv7(), categoriaId: catId, nombre },
      });
      r.subcategorias++;
    }
    subcategoriaId.set(par, s.id);
  }

  const existentes = new Set(
    (await prisma.articulo.findMany({ select: { codigo: true } })).map((a) =>
      a.codigo.toUpperCase(),
    ),
  );
  const nuevos = datos.articulos.filter((a) => !existentes.has(a.codigo.toUpperCase()));
  r.yaExistian = datos.articulos.length - nuevos.length;

  for (let i = 0; i < nuevos.length; i += LOTE) {
    const lote = nuevos.slice(i, i + LOTE);
    const ids = lote.map(() => uuidv7());
    await prisma.$transaction(async (tx) => {
      await tx.articulo.createMany({
        data: lote.map((a, k) => ({
          id: ids[k],
          codigo: a.codigo,
          nombre: a.nombre,
          nombreComercial: a.nombreComercial,
          categoriaId: categoriaId.get(a.categoria) as string,
          subcategoriaId: a.subcategoria
            ? (subcategoriaId.get(`${a.categoria}\u0000${a.subcategoria}`) as string)
            : null,
          unidadStockId: unidad.id,
          nota: a.nota,
        })),
      });
      const equivalencias = lote
        .map((a, k) => ({ a, id: ids[k] }))
        .filter((x) => x.a.codigoAs2)
        .map((x) => ({
          id: uuidv7(),
          articuloId: x.id,
          codigo: x.a.codigoAs2 as string,
          motivo: 'formato' as const,
        }));
      if (equivalencias.length) {
        await tx.articuloEquivalencia.createMany({ data: equivalencias });
        r.equivalencias += equivalencias.length;
      }
    });
    r.articulos += lote.length;
  }
  return r;
}

async function main() {
  const prisma = new PrismaClient({
    adapter: new PrismaPg(
      { connectionString: toPgConnectionString(process.env['DATABASE_URL'] as string) },
      { schema: 'inventario' },
    ),
  });
  try {
    const r = await cargarBienesAs2(prisma);
    console.log(
      `Bienes de AS2: ${r.articulos} artículos nuevos (${r.yaExistian} ya existían), ${r.equivalencias} códigos originales como equivalencia, ` +
        `${r.categorias} categorías y ${r.subcategorias} subcategorías nuevas`,
    );
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
