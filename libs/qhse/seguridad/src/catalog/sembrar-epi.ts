import { uuidv7 } from '@dyn/utils';
import type { PrismaClient, TipoTalla } from '../generated/client';

/**
 * Tallas del formato DYN-SGI-RE-032 por tipo de talla. Es lo único que QHSE siembra: los ELEMENTOS de EPI son artículos de Inventario
 * (categoría EPP de AS2) y llegan por el evento `operaciones.inventario.articulo_epi_actualizado` (decisión D16); para la carga
 * inicial, Inventario los republica (`POST /api/operaciones/inventario/articulos/epi/republicar`).
 * Las tallas son valores de uso común (la talla no es parte del artículo en AS2: iba en el nombre del producto); QHSE las ajusta.
 */
export const TALLAS_EPI: Readonly<Record<TipoTalla, readonly string[]>> = {
  ropa: ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL'],
  calzado: ['35', '36', '37', '38', '39', '40', '41', '42', '43', '44', '45', '46'],
  guante: ['7', '8', '9', '10', '11'],
};

/** Idempotente: solo agrega las tallas que faltan y no toca lo que QHSE ya ajustó. */
export async function sembrarEpi(prisma: PrismaClient): Promise<{ tallas: number }> {
  let nuevasTallas = 0;
  for (const [tipo, codigosTalla] of Object.entries(TALLAS_EPI) as [
    TipoTalla,
    readonly string[],
  ][]) {
    const existentes = await prisma.epiTalla.findMany({
      where: { tipo },
      select: { codigo: true },
    });
    const ya = new Set(existentes.map((t) => t.codigo));
    for (const [i, codigo] of codigosTalla.entries()) {
      if (ya.has(codigo)) continue;
      await prisma.epiTalla.create({ data: { id: uuidv7(), tipo, codigo, orden: i + 1 } });
      nuevasTallas++;
    }
  }
  return { tallas: nuevasTallas };
}
