/** Un ticket abierto en el que un operador ya está asignado, visto como un rango de días. Las fechas son 'YYYY-MM-DD'. */
export interface Ocupacion {
  ticketId: string;
  ticketNumero: number | null;
  pedidoCodigo: string;
  /** `null`: el pedido no trae fecha de inicio, se asume ocupado desde siempre (lo más estricto). */
  desde: string | null;
  /** `null`: ocupado hasta que se cierre el ticket (sin fecha de fin, o su fecha ya pasó y sigue abierto). */
  hasta: string | null;
}

export interface Disponibilidad {
  disponible: boolean;
  /** La razón en una frase para la pantalla de asignación. */
  detalle: string;
  /** Las ocupaciones que se cruzan con el rango, por fecha de inicio. */
  ocupaciones: Ocupacion[];
}

/** 'YYYY-MM-DD' → 'dd/mm', como en la pantalla de la demo. */
const corta = (iso: string): string => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

const diaSiguiente = (iso: string): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

const etiquetaTicket = (o: Ocupacion): string => String(o.ticketNumero ?? o.pedidoCodigo);

/**
 * Disponibilidad de un operador frente a un rango de días. No es un sí o no: distingue a quien está ocupado todo el rango, a quien se
 * ocupa a mitad del rango y a quien se libera a mitad del rango, para que el Supervisor entienda por qué no califica y ajuste las fechas.
 * Los textos son los de la demo.
 */
export function evaluarDisponibilidad(
  desde: string,
  hasta: string,
  ocupaciones: Ocupacion[],
): Disponibilidad {
  const cruzan = ocupaciones
    .filter((o) => (o.desde === null || o.desde <= hasta) && (o.hasta === null || o.hasta >= desde))
    .sort((a, b) => (a.desde ?? '').localeCompare(b.desde ?? ''));
  const primera = cruzan[0];
  if (!primera) return { disponible: true, detalle: 'Disponible todo el rango', ocupaciones: [] };

  const cubreTodo =
    (primera.desde === null || primera.desde <= desde) &&
    (primera.hasta === null || primera.hasta >= hasta);
  let detalle: string;
  if (cubreTodo) {
    detalle = `Ocupado todo el rango (${
      primera.hasta
        ? `hasta ${corta(primera.hasta)}`
        : `hasta que se cierre el ticket ${etiquetaTicket(primera)}`
    })`;
  } else if (primera.desde !== null && primera.desde > desde) {
    detalle = `Disponible al inicio, sale del rango el ${corta(primera.desde)}`;
  } else {
    // no cubre todo y empieza antes del rango: tiene fin dentro del rango
    detalle = `Ocupado al inicio, se incorpora el ${corta(diaSiguiente(primera.hasta as string))}`;
  }
  return { disponible: false, detalle, ocupaciones: cruzan };
}
