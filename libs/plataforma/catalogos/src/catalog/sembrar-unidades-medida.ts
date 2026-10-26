import { uuidv7 } from '@dyn/utils';
import type { PrismaClient } from '../generated/client';

/** Unidades de medida base (nombre y símbolo): las de bodega y las de servicio de las listas de precios. Antes eran de Inventario (`unidad_stock`); ahora son de la plataforma (IN9, CM-4). */
export const UNIDADES_MEDIDA_BASE: ReadonlyArray<{
  nombre: string;
  simbolo: string;
  /** Solo las de tiempo. */
  periodo?: 'hora' | 'dia' | 'semana' | 'mes';
}> = [
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
  // de servicio (listas de precios y FCR), CM-4; también las agrega la migración 20261026100000_unidades_de_servicio
  { nombre: 'Hora', simbolo: 'h', periodo: 'hora' },
  { nombre: 'Día', simbolo: 'd', periodo: 'dia' },
  { nombre: 'Semana', simbolo: 'sem', periodo: 'semana' },
  { nombre: 'Mes', simbolo: 'mes', periodo: 'mes' },
  { nombre: 'Corrida', simbolo: 'corrida' },
  { nombre: 'Servicio', simbolo: 'serv' },
  { nombre: 'Kilómetro', simbolo: 'km' },
  { nombre: 'Metro cúbico', simbolo: 'm3' },
  { nombre: 'Pie cúbico', simbolo: 'ft3' },
  { nombre: 'Tonelada', simbolo: 't' },
  { nombre: 'Tonelada·kilómetro', simbolo: 't·km' },
  { nombre: 'Trabajo', simbolo: 'trabajo' },
  { nombre: 'HHP·hora', simbolo: 'HHP·h' },
];

/** Siembra las unidades base (idempotente: lo que ya existe, por nombre, no se toca; el período lo pone la migración). */
export async function sembrarUnidadesMedida(prisma: PrismaClient): Promise<number> {
  const r = await prisma.unidadMedida.createMany({
    data: UNIDADES_MEDIDA_BASE.map((x) => ({ id: uuidv7(), ...x })),
    skipDuplicates: true,
  });
  return r.count;
}
