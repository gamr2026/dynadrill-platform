/**
 * Carga del equipo de protección personal (EPP) desde el reporte «Atributos por Producto» de AS2, ya depurado en
 * `prisma/data/epp.json` (ver `prisma/data/README.md`: qué se excluyó, qué se fusionó y por qué).
 *   npm run db:cargar:epp
 * Idempotente y sin pisar nada: un artículo que ya existe no se toca. No registra saldos: el reporte de AS2 no trae existencias.
 *
 * Variable: DATABASE_URL (usuario app_operaciones).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { loadDotenv } from '@dyn/config';
import { toPgConnectionString } from '@dyn/messaging';
import { uuidv7 } from '@dyn/utils';
import { sembrarCatalogos, UNIDAD_POR_DEFECTO } from '../src/catalog/sembrar-catalogos';
import { PrismaClient, type TipoTalla } from '../src/generated/client';

loadDotenv('apps/operaciones/.env', '.env');

interface ArticuloEpp {
  codigo: string;
  nombre: string;
  nombreComercial: string | null;
  categoria: string;
  subcategoria: string;
  entregaPersonal: boolean;
  tipoTalla: TipoTalla | null;
  codigosAlternos: string[];
}
interface Fusion {
  base: string;
  motivo: string;
  desde: string[];
}
interface ArchivoEpp {
  articulos: ArticuloEpp[];
  fusionados: Fusion[];
}

const MOTIVO: Record<string, 'talla' | 'duplicado' | 'digitacion'> = {
  'tallas como productos': 'talla',
  duplicado: 'duplicado',
  'error de digitación (PATALON)': 'digitacion',
};

export interface ResumenEpp {
  categorias: number;
  subcategorias: number;
  articulos: number;
  yaExistian: number;
  equivalencias: number;
}

export async function cargarEpp(prisma: PrismaClient): Promise<ResumenEpp> {
  await sembrarCatalogos(prisma);
  const datos = JSON.parse(readFileSync(join(__dirname, 'data', 'epp.json'), 'utf8')) as ArchivoEpp;
  const motivoDe = new Map(
    datos.fusionados.flatMap((f) => f.desde.map((c) => [c, MOTIVO[f.motivo]] as const)),
  );
  const unidad = await prisma.catUnidadMedida.findUniqueOrThrow({
    where: { nombre: UNIDAD_POR_DEFECTO },
  });
  const r: ResumenEpp = {
    categorias: 0,
    subcategorias: 0,
    articulos: 0,
    yaExistian: 0,
    equivalencias: 0,
  };

  for (const a of datos.articulos) {
    let categoria = await prisma.categoriaArticulo.findUnique({ where: { nombre: a.categoria } });
    if (!categoria) {
      categoria = await prisma.categoriaArticulo.create({
        data: { id: uuidv7(), nombre: a.categoria },
      });
      r.categorias++;
    }
    let sub = await prisma.subcategoriaArticulo.findUnique({
      where: { categoriaId_nombre: { categoriaId: categoria.id, nombre: a.subcategoria } },
    });
    if (!sub) {
      sub = await prisma.subcategoriaArticulo.create({
        data: { id: uuidv7(), categoriaId: categoria.id, nombre: a.subcategoria },
      });
      r.subcategorias++;
    }
    const existente = await prisma.articulo.findUnique({
      where: { codigo: a.codigo },
      select: { id: true },
    });
    if (existente) {
      r.yaExistian++;
      continue;
    }
    // un código de equivalencia no puede ser el código principal de otro artículo
    for (const c of a.codigosAlternos) {
      if (await prisma.articulo.findUnique({ where: { codigo: c }, select: { id: true } }))
        throw new Error(`El código ${c} ya es el código principal de otro artículo`);
    }
    const id = uuidv7();
    await prisma.$transaction(async (tx) => {
      await tx.articulo.create({
        data: {
          id,
          codigo: a.codigo,
          nombre: a.nombre,
          nombreComercial: a.nombreComercial,
          categoriaId: categoria.id,
          subcategoriaId: sub.id,
          unidadStockId: unidad.id,
          entregaPersonal: a.entregaPersonal,
          tipoTalla: a.tipoTalla,
        },
      });
      for (const c of a.codigosAlternos) {
        await tx.articuloEquivalencia.create({
          data: {
            id: uuidv7(),
            articuloId: id,
            codigo: c,
            motivo: motivoDe.get(c) ?? 'duplicado',
          },
        });
        r.equivalencias++;
      }
    });
    r.articulos++;
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
    const r = await cargarEpp(prisma);
    console.log(
      `EPP: ${r.articulos} artículos nuevos (${r.yaExistian} ya existían), ${r.equivalencias} equivalencias de AS2, ` +
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
