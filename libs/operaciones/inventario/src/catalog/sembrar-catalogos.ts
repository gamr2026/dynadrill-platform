import { uuidv7 } from '@dyn/utils';
import type { PrismaClient } from '../generated/client';

/** Unidades de stock más usadas en bodega (nombre y símbolo). */
export const UNIDADES_STOCK: ReadonlyArray<{ nombre: string; simbolo: string }> = [
  { nombre: 'Unidad', simbolo: 'und' },
  { nombre: 'Galón', simbolo: 'gal' },
  { nombre: 'Litro', simbolo: 'l' },
  { nombre: 'Kilogramo', simbolo: 'kg' },
  { nombre: 'Libra', simbolo: 'lb' },
  { nombre: 'Saco', simbolo: 'sc' },
  { nombre: 'Tambor', simbolo: 'tbr' },
  { nombre: 'Balde', simbolo: 'bld' },
  { nombre: 'Caja', simbolo: 'cja' },
  { nombre: 'Metro', simbolo: 'm' },
  { nombre: 'Pie', simbolo: 'ft' },
  { nombre: 'Par', simbolo: 'par' },
  { nombre: 'Juego', simbolo: 'jgo' },
];

/** Categorías que agrupan químicos y las que llevan lista de partes, por defecto (el nombre es el del export de AS2). Solo la semilla y la carga inicial usan estos nombres: el sistema decide siempre por `es_quimica` y `lleva_partes`. */
export const CATEGORIAS_QUIMICAS: readonly string[] = ['QUIMICA'];
export const CATEGORIAS_CON_PARTES: readonly string[] = ['FISHING & TOOLS', 'HERRAMIENTAS'];
/** Categoría de repuestos y suministros de mantenimiento (reporte de AS2: «MANTENIMIENTO / SUMINISTROS Y MANTENIMIENTO»). */
export const CATEGORIAS_REPUESTOS: readonly string[] = ['MANTENIMIENTO'];

/** Unidad con la que se carga el catálogo de AS2, que no trae la unidad de cada producto (ver CONSULTAS-PARA-DYNADRILL.md). */
export const UNIDAD_POR_DEFECTO = 'Unidad';

type Motivo = {
  nombre: string;
  tipo: 'entrada' | 'salida';
  origen:
    | 'saldo_inicial'
    | 'compra'
    | 'ajuste'
    | 'despacho_bodega'
    | 'salida_ticket'
    | 'devolucion_ticket';
  manual: boolean;
};

/**
 * Motivos de movimiento. Cada uno fija el tipo y el origen; `manual` indica si la pantalla permite elegirlo (los demás los
 * registra el sistema: carga inicial, despachos y tickets).
 */
export const MOTIVOS: ReadonlyArray<Motivo> = [
  { nombre: 'Saldo inicial', tipo: 'entrada', origen: 'saldo_inicial', manual: false },
  { nombre: 'Compra', tipo: 'entrada', origen: 'compra', manual: true },
  {
    nombre: 'Ajuste por conteo físico (sobrante)',
    tipo: 'entrada',
    origen: 'ajuste',
    manual: true,
  },
  { nombre: 'Ajuste por conteo físico (faltante)', tipo: 'salida', origen: 'ajuste', manual: true },
  { nombre: 'Baja por daño o vencimiento', tipo: 'salida', origen: 'ajuste', manual: true },
  { nombre: 'Devolución a proveedor', tipo: 'salida', origen: 'ajuste', manual: true },
  {
    nombre: 'Despacho a bodega de cliente',
    tipo: 'salida',
    origen: 'despacho_bodega',
    manual: false,
  },
  { nombre: 'Salida para ticket', tipo: 'salida', origen: 'salida_ticket', manual: false },
  { nombre: 'Devolución de ticket', tipo: 'entrada', origen: 'devolucion_ticket', manual: false },
];

/** Siembra las unidades y los motivos (idempotente: lo que ya existe no se toca). */
export async function sembrarCatalogos(
  prisma: PrismaClient,
): Promise<{ unidades: number; motivos: number }> {
  const u = await prisma.unidadStock.createMany({
    data: UNIDADES_STOCK.map((x) => ({ id: uuidv7(), ...x })),
    skipDuplicates: true,
  });
  const m = await prisma.motivoMovimiento.createMany({
    data: MOTIVOS.map((x) => ({ id: uuidv7(), ...x })),
    skipDuplicates: true,
  });
  return { unidades: u.count, motivos: m.count };
}

/** Marca las categorías base (idempotente): solo enciende lo que está apagado, no vuelve a apagar lo que un administrador encendió. */
export async function marcarCategoriasBase(prisma: PrismaClient): Promise<void> {
  await prisma.categoriaArticulo.updateMany({
    where: { nombre: { in: [...CATEGORIAS_QUIMICAS] }, esQuimica: false },
    data: { esQuimica: true },
  });
  await prisma.categoriaArticulo.updateMany({
    where: { nombre: { in: [...CATEGORIAS_CON_PARTES] }, llevaPartes: false },
    data: { llevaPartes: true },
  });
  await prisma.categoriaArticulo.updateMany({
    where: { nombre: { in: [...CATEGORIAS_REPUESTOS] }, esRepuesto: false },
    data: { esRepuesto: true },
  });
}
