/** Las marcas de una herramienta del ticket (las columnas de `ticket_herramienta` que dicen en qué punto del recorrido va). */
export interface MarcasHerramienta {
  solicitadaAt: Date | null;
  preparadaAt: Date | null;
  bodegaNovedad: string | null;
  enviadaAt: Date | null;
  recibidaAt: Date | null;
  recepcionNovedad: string | null;
  devueltaAt: Date | null;
  faltanteAt: Date | null;
}

/**
 * Dónde va la herramienta. No se guarda: se deduce de las marcas (la base garantiza que van en orden: solicitada → preparada → enviada →
 * recibida → devuelta o faltante), así no puede quedar un estado que contradiga sus fechas.
 */
export type EstadoHerramienta =
  | 'seleccionada'
  | 'solicitada'
  | 'novedad_bodega'
  | 'preparada'
  | 'enviada'
  | 'novedad_recepcion'
  | 'recibida'
  | 'devuelta'
  | 'faltante';

export function estadoDeHerramienta(h: MarcasHerramienta): EstadoHerramienta {
  if (h.devueltaAt) return 'devuelta';
  if (h.faltanteAt) return 'faltante';
  if (h.recibidaAt) return 'recibida';
  if (h.enviadaAt) return h.recepcionNovedad ? 'novedad_recepcion' : 'enviada';
  if (h.preparadaAt) return 'preparada';
  if (h.solicitadaAt) return h.bodegaNovedad ? 'novedad_bodega' : 'solicitada';
  return 'seleccionada';
}
