/**
 * Carga inicial del catálogo de artículos y su saldo, desde los exports reales de AS2 (`prisma/data/`, tomados del `main` de la
 * demo): `inventario.json` (641 artículos con costo y saldo) y `descuentos.json` (descuento sugerido por código).
 *   npm run db:cargar:inventario
 * Es idempotente y NO pisa lo que ya se administra en el portal: un artículo que ya existe no se toca y un saldo inicial no
 * se repite. Las listas de precios por cliente no son de Inventario: las cargó Pedidos (comercial).
 *
 * Variables: DATABASE_URL (usuario app_operaciones). Opcionales: INVENTARIO_CARGA_BODEGA (por defecto «Bodega Matriz», donde
 * se registra el saldo inicial: el export de AS2 no trae la bodega) e INVENTARIO_CARGA_USUARIO_ID (cuenta responsable de los
 * movimientos; por defecto, un Superadmin).
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
  marcarCategoriasBase,
  sembrarCatalogos,
  UNIDAD_POR_DEFECTO,
} from '../src/catalog/sembrar-catalogos';
import { Prisma, PrismaClient } from '../src/generated/client';
import { registrarEnKardex } from '../src/services/kardex';
import { HERRAMIENTAS_SEED_DATA } from './data/herramientas.seed-data';

loadDotenv('apps/operaciones/.env', '.env');

interface ArticuloReal {
  codigo: string;
  nombre: string;
  categoria: string;
  subcategoria: string;
  costoUnitario: number | null;
  stockActual: number;
}
interface DescuentoReal {
  codigo: string;
  descuentoSugerido: number;
}

/** Categoría de las herramientas del registro de inspección de Dynadrill (no existen en el export de AS2). */
const CATEGORIA_HERRAMIENTAS = 'HERRAMIENTAS';

const leer = <T>(archivo: string): T =>
  JSON.parse(readFileSync(join(__dirname, 'data', archivo), 'utf8')) as T;

export interface ResumenCarga {
  categorias: number;
  subcategorias: number;
  articulos: number;
  yaExistian: number;
  saldosIniciales: number;
  descuentos: number;
  costosNegativosOmitidos: number;
  saldosNegativosOmitidos: number;
  herramientas: number;
  partes: number;
}

export async function cargarDatosReales(
  prisma: PrismaClient,
  opciones: { bodega?: string; responsableId?: string } = {},
): Promise<ResumenCarga> {
  await sembrarCatalogos(prisma);
  const articulos = leer<ArticuloReal[]>('inventario.json');
  const descuentos = new Map(
    leer<DescuentoReal[]>('descuentos.json').map((d) => [d.codigo, d.descuentoSugerido]),
  );

  const bodegaNombre = opciones.bodega ?? 'Bodega Matriz';
  const bodega = await prisma.catBodega.findFirst({ where: { nombre: bodegaNombre } });
  if (!bodega) throw new Error(`La bodega «${bodegaNombre}» no existe en el catálogo de bodegas`);
  const responsable = opciones.responsableId
    ? await prisma.idUsuario.findUnique({ where: { id: opciones.responsableId } })
    : await prisma.idUsuario.findFirst({
        where: { rol: { codigo: 'superadmin' } },
        orderBy: [{ activo: 'desc' }, { nombre: 'asc' }],
      });
  if (!responsable)
    throw new Error('No hay una cuenta responsable para los movimientos (Superadmin)');
  const unidad = await prisma.unidadStock.findUniqueOrThrow({
    where: { nombre: UNIDAD_POR_DEFECTO },
  });
  const motivoSaldo = await prisma.motivoMovimiento.findUniqueOrThrow({
    where: { nombre: 'Saldo inicial' },
  });

  const r: ResumenCarga = {
    categorias: 0,
    subcategorias: 0,
    articulos: 0,
    yaExistian: 0,
    saldosIniciales: 0,
    descuentos: 0,
    costosNegativosOmitidos: 0,
    saldosNegativosOmitidos: 0,
    herramientas: 0,
    partes: 0,
  };

  // categorías y subcategorías (las que aparecen en el export)
  const categoriaId = new Map<string, string>();
  const subcategoriaId = new Map<string, string>();
  for (const nombre of new Set(articulos.map((a) => a.categoria.trim()))) {
    let c = await prisma.categoriaArticulo.findUnique({ where: { nombre } });
    if (!c) {
      c = await prisma.categoriaArticulo.create({
        data: {
          id: uuidv7(),
          nombre,
          esQuimica: CATEGORIAS_QUIMICAS.includes(nombre),
          llevaPartes: CATEGORIAS_CON_PARTES.includes(nombre),
        },
      });
      r.categorias++;
    }
    categoriaId.set(nombre, c.id);
  }
  for (const par of new Set(
    articulos
      .filter((a) => a.subcategoria.trim())
      .map((a) => `${a.categoria.trim()}\u0000${a.subcategoria.trim()}`),
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

  for (const a of articulos) {
    const codigo = a.codigo.trim();
    const existente = await prisma.articulo.findUnique({ where: { codigo }, select: { id: true } });
    if (existente) r.yaExistian++;
    let costo = a.costoUnitario;
    if (costo !== null && costo < 0) {
      costo = null; // un costo negativo del export de AS2 no es un costo real
      r.costosNegativosOmitidos++;
    }
    const descuento = descuentos.get(codigo);

    await prisma.$transaction(async (tx) => {
      let articuloId = existente?.id;
      if (!articuloId) {
        const cat = a.categoria.trim();
        const creado = await tx.articulo.create({
          data: {
            id: uuidv7(),
            codigo,
            nombre: a.nombre.trim(),
            categoriaId: categoriaId.get(cat) as string,
            subcategoriaId: a.subcategoria.trim()
              ? subcategoriaId.get(`${cat}\u0000${a.subcategoria.trim()}`)
              : null,
            unidadStockId: unidad.id,
            costoUnitario: costo,
            descuentoSugerido: descuento ?? null,
            createdBy: responsable.id,
            updatedBy: responsable.id,
          },
        });
        articuloId = creado.id;
        r.articulos++;
        if (descuento !== undefined) r.descuentos++;
      }
      if (a.stockActual < 0) {
        r.saldosNegativosOmitidos++;
        return;
      }
      if (a.stockActual > 0) {
        const yaTiene = await tx.movimiento.count({
          where: { articuloId, origen: 'saldo_inicial' },
        });
        if (!yaTiene) {
          await registrarEnKardex(tx, {
            articuloId,
            bodegaId: bodega.id,
            motivoId: motivoSaldo.id,
            cantidad: new Prisma.Decimal(a.stockActual),
            responsableId: responsable.id,
            observacion: 'Saldo inicial del kardex de AS2',
          });
          r.saldosIniciales++;
        }
      }
    });
  }
  await cargarHerramientas(prisma, unidad.id, responsable.id, r);
  await marcarCategoriasBase(prisma);
  return r;
}

/**
 * Las 48 herramientas del registro de inspección y reparación de Dynadrill (914 partes), con su propio código: no están en el export de
 * AS2 (ver consulta IN10). Se cargan como artículos de la categoría HERRAMIENTAS, sin existencias, y sus partes; si la herramienta ya
 * existe o ya tiene partes, no se toca.
 */
async function cargarHerramientas(
  prisma: PrismaClient,
  unidadId: string,
  responsableId: string,
  r: ResumenCarga,
) {
  const categoria =
    (await prisma.categoriaArticulo.findUnique({ where: { nombre: CATEGORIA_HERRAMIENTAS } })) ??
    (await prisma.categoriaArticulo.create({
      data: {
        id: uuidv7(),
        nombre: CATEGORIA_HERRAMIENTAS,
        llevaPartes: true,
        createdBy: responsableId,
        updatedBy: responsableId,
      },
    }));
  for (const h of HERRAMIENTAS_SEED_DATA) {
    await prisma.$transaction(async (tx) => {
      let articulo = await tx.articulo.findUnique({
        where: { codigo: h.codigo },
        select: { id: true },
      });
      if (!articulo) {
        articulo = await tx.articulo.create({
          data: {
            id: uuidv7(),
            codigo: h.codigo,
            nombre: h.nombre,
            categoriaId: categoria.id,
            unidadStockId: unidadId,
            createdBy: responsableId,
            updatedBy: responsableId,
          },
          select: { id: true },
        });
        r.herramientas++;
      }
      if (await tx.articuloParte.count({ where: { articuloId: articulo.id } })) return;
      await tx.articuloParte.createMany({
        data: h.partes.map((p) => ({
          id: uuidv7(),
          articuloId: articulo.id,
          orden: p.orden,
          item: p.item,
          codigo: p.codigo,
          descripcion: p.descripcion,
          cantidadEsperada: p.cantidadEsperada,
          createdBy: responsableId,
          updatedBy: responsableId,
        })),
      });
      r.partes += h.partes.length;
    });
  }
}

async function main() {
  const prisma = new PrismaClient({
    adapter: new PrismaPg(
      { connectionString: toPgConnectionString(process.env['DATABASE_URL'] as string) },
      { schema: 'inventario' },
    ),
  });
  try {
    const r = await cargarDatosReales(prisma, {
      bodega: process.env['INVENTARIO_CARGA_BODEGA'],
      responsableId: process.env['INVENTARIO_CARGA_USUARIO_ID'],
    });
    console.log(
      `inventario: ${r.categorias} categorías, ${r.subcategorias} subcategorías y ${r.articulos} artículos nuevos ` +
        `(${r.yaExistian} ya existían), ${r.saldosIniciales} saldos iniciales, ${r.descuentos} descuentos sugeridos; ` +
        `${r.herramientas} herramientas con ${r.partes} partes`,
    );
    if (r.costosNegativosOmitidos || r.saldosNegativosOmitidos) {
      console.log(
        `inventario: omitidos por dato inválido del export de AS2: ${r.costosNegativosOmitidos} costos negativos y ${r.saldosNegativosOmitidos} saldos negativos`,
      );
    }
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
