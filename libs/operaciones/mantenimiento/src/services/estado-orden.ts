/**
 * El estado de la orden NUNCA se guarda: se deriva de sus sub-órdenes (regla de la demo). Solo llega a `cerrada` cuando la unidad
 * se devolvió a Operaciones (retorno a operación).
 */
export type EstadoOrden =
  'pendiente' | 'en_mantenimiento' | 'requiere_cambios' | 'aceptada' | 'cerrada';

export interface SubordenParaEstado {
  estadoCodigo: string;
  /** Del catálogo `estado_suborden.resuelta`: cerrada o derivada a Pumping. */
  resuelta: boolean;
}

/** Estados en los que alguien está trabajando la sub-orden. */
const EN_TRABAJO = new Set(['en_diagnostico', 'en_ejecucion', 'en_revision_cierre']);

export function estadoDeOrden(retornada: boolean, subordenes: SubordenParaEstado[]): EstadoOrden {
  if (retornada) return 'cerrada';
  if (subordenes.length === 0) return 'pendiente';
  if (subordenes.some((s) => s.estadoCodigo === 'correccion_solicitada')) return 'requiere_cambios';
  if (subordenes.every((s) => s.resuelta)) return 'aceptada';
  if (subordenes.some((s) => EN_TRABAJO.has(s.estadoCodigo))) return 'en_mantenimiento';
  return 'pendiente';
}
