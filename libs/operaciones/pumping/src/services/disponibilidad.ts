/**
 * La regla de ocupación del personal de Pumping, en un solo lugar: la usan la lista de disponibilidad (pantalla de asignación) y la
 * validación de la asignación, para que nunca discrepen. Una persona está ocupada por todo ticket de un paso no terminal (ni cerrado ni
 * anulado) en el que está asignada y cuyo rango de servicio se cruza con el rango consultado. Un ticket libera a su equipo el día de fin del
 * servicio (el del pedido); si ese día ya pasó y el ticket sigue abierto, hasta que se cierre. Sin fecha de inicio se asume ocupado desde
 * siempre y sin fecha de fin, hasta el cierre (lo más estricto). Las fechas son 'AAAA-MM-DD'.
 */

/** Roles de cuenta que pueden ser supervisor, operador o conductor de un servicio. */
export const ROLES_SUPERVISOR = ['supervisor', 'supervisor_pumping'];
export const ROLES_OPERADOR = ['operador'];
export const ROLES_CONDUCTOR = ['conductor'];

/** Un ticket abierto en el que una persona ya está asignada, visto como un rango de días. */
export interface Ocupacion {
  ticketId: string;
  ticketNumero: number | null;
  pedidoCodigo: string;
  cliente: string | null;
  /** `null`: el pedido no trae fecha de inicio, se asume ocupado desde siempre. */
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

export interface Rango {
  desde: string;
  hasta: string;
}

const dia = (d: Date): string => d.toISOString().slice(0, 10);

/** La ocupación que un ticket abierto le impone a su equipo (a partir de sus fechas de servicio y de hoy). */
export function ocupacionDeTicket(
  t: {
    id: string;
    ticketNumero: number | null;
    pedidoCodigo: string;
    cliente: string | null;
    fechaInicioServicio: Date | null;
    fechaFinServicio: Date | null;
  },
  hoy: string,
): Ocupacion {
  const fin = t.fechaFinServicio ? dia(t.fechaFinServicio) : null;
  return {
    ticketId: t.id,
    ticketNumero: t.ticketNumero,
    pedidoCodigo: t.pedidoCodigo,
    cliente: t.cliente,
    desde: t.fechaInicioServicio ? dia(t.fechaInicioServicio) : null,
    // si su servicio ya pasó su fecha de fin y sigue abierto, la persona sigue ocupada hasta que se cierre
    hasta: fin && fin >= hoy ? fin : null,
  };
}

/** ¿La ocupación se cruza con el rango? */
export const seCruza = (rango: Rango, o: Ocupacion): boolean =>
  (o.desde === null || o.desde <= rango.hasta) && (o.hasta === null || o.hasta >= rango.desde);

/**
 * El rango de servicio de un ticket: de su inicio (o `desde`, o hoy si no tiene) a su fin (o, sin fin, el mismo día de inicio).
 * Con `desde` solo se miran los días a partir de esa fecha (al ampliar un servicio, los anteriores ya estaban asignados).
 */
export function rangoDeServicio(
  t: { fechaInicioServicio: Date | null; fechaFinServicio: Date | null },
  hoy: string,
  desde?: Date,
): Rango {
  const inicio = desde ? dia(desde) : t.fechaInicioServicio ? dia(t.fechaInicioServicio) : hoy;
  return { desde: inicio, hasta: t.fechaFinServicio ? dia(t.fechaFinServicio) : inicio };
}

/** 'AAAA-MM-DD' a 'dd/mm', como en la pantalla de la demo. */
const corta = (iso: string): string => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

const diaSiguiente = (iso: string): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

const etiquetaTicket = (o: Ocupacion): string => String(o.ticketNumero ?? o.pedidoCodigo);

/**
 * Disponibilidad de una persona frente a un rango de días. No es un sí o no: distingue a quien está ocupado todo el rango, a quien se
 * ocupa a mitad del rango y a quien se libera a mitad del rango, para que quien asigna entienda por qué no califica y ajuste las fechas.
 */
export function evaluarDisponibilidad(rango: Rango, ocupaciones: Ocupacion[]): Disponibilidad {
  const cruzan = ocupaciones
    .filter((o) => seCruza(rango, o))
    .sort((a, b) => (a.desde ?? '').localeCompare(b.desde ?? ''));
  const primera = cruzan[0];
  if (!primera) return { disponible: true, detalle: 'Disponible todo el rango', ocupaciones: [] };

  const cubreTodo =
    (primera.desde === null || primera.desde <= rango.desde) &&
    (primera.hasta === null || primera.hasta >= rango.hasta);
  let detalle: string;
  if (cubreTodo) {
    detalle = `Ocupado todo el rango (${
      primera.hasta
        ? `hasta ${corta(primera.hasta)}`
        : `hasta que se cierre el ticket ${etiquetaTicket(primera)}`
    })`;
  } else if (primera.desde !== null && primera.desde > rango.desde) {
    detalle = `Disponible al inicio, sale del rango el ${corta(primera.desde)}`;
  } else {
    // no cubre todo y empieza antes del rango: tiene fin dentro del rango
    detalle = `Ocupado al inicio, se incorpora el ${corta(diaSiguiente(primera.hasta as string))}`;
  }
  return { disponible: false, detalle, ocupaciones: cruzan };
}
