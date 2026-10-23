import { uuidv7 } from '@dyn/utils';
import type { PrismaClient } from '../generated/client';

/** Unidades de medida base (nombre y símbolo): las más usadas en bodega. Antes eran de Inventario (`unidad_stock`); ahora son de la plataforma (IN9). */
export const UNIDADES_MEDIDA_BASE: ReadonlyArray<{ nombre: string; simbolo: string }> = [
  { nombre: 'Unidad', simbolo: 'und' },
  { nombre: 'Galón', simbolo: 'gal' },
  { nombre: 'Litro', simbolo: 'l' },
  { nombre: 'Kilogramo', simbolo: 'kg' },
  { nombre: 'Barril', simbolo: 'bbl' },
  { nombre: 'Metro cuadrado', simbolo: 'm2' },
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

/** Siembra las unidades base (idempotente: lo que ya existe, por nombre, no se toca). */
export async function sembrarUnidadesMedida(prisma: PrismaClient): Promise<number> {
  const r = await prisma.unidadMedida.createMany({
    data: UNIDADES_MEDIDA_BASE.map((x) => ({ id: uuidv7(), ...x })),
    skipDuplicates: true,
  });
  return r.count;
}
