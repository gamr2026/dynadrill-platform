/** Una unidad de Flota con, si lo tiene, el vehículo del catálogo enlazado (`flota.unidad.vehiculo_id`). */
export interface UnidadConVehiculo {
  codigo: string;
  vehiculo?: { placa: string } | null;
}

/** Cómo se nombra una unidad en pantallas y avisos: su placa si tiene vehículo enlazado y, si no, su código de Flota. */
export const etiquetaDeUnidad = (u: UnidadConVehiculo): string => u.vehiculo?.placa ?? u.codigo;

/** `include` de Prisma para traer la unidad de Flota con la placa de su vehículo enlazado. */
export const UNIDAD_CON_PLACA = { include: { vehiculo: { select: { placa: true } } } } as const;
