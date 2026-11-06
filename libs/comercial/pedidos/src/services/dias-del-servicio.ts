import type { Prisma } from '../generated/client';

const aDiaTxt = (d: Date) => d.toISOString().slice(0, 10);
const dmy = (f: string) => `${f.slice(8, 10)}/${f.slice(5, 7)}/${f.slice(0, 4)}`;

export interface RangoServicio {
  inicio: Date | null;
  fin: Date | null;
}

/** El día cae dentro de las fechas del servicio del pedido (sin fecha de inicio o de fin, ese extremo no limita). */
export const dentroDelServicio = (dia: Date, r: RangoServicio): boolean =>
  (!r.inicio || dia.getTime() >= r.inicio.getTime()) &&
  (!r.fin || dia.getTime() <= r.fin.getTime());

/**
 * Dice por qué ciertos días ya no cuentan: quedaron fuera de las fechas del servicio, casi siempre porque Operaciones acortó la duración al
 * terminar antes el trabajo. Con el último cambio de duración del pedido da su fecha, el ticket y el motivo.
 */
export async function explicarDiasFuera(
  db: Pick<Prisma.TransactionClient, 'pedidoCambioDuracion'>,
  pedidoId: string,
  dias: string[],
): Promise<string> {
  const lista = [...new Set(dias)].sort().map(dmy).join(', ');
  const ultimo = await db.pedidoCambioDuracion.findFirst({
    where: { pedidoId, accion: 'acortar' },
    orderBy: { createdAt: 'desc' },
  });
  const porque = ultimo
    ? ` El servicio se acortó hasta el ${dmy(aDiaTxt(ultimo.fechaFinNueva))}${ultimo.ticketNumero ? ` (ticket ${ultimo.ticketNumero})` : ''}. Motivo: ${ultimo.motivo}.`
    : ' Están fuera de las fechas del servicio del pedido.';
  return `Los días ${lista} no se cuentan ni se facturan.${porque}`;
}
