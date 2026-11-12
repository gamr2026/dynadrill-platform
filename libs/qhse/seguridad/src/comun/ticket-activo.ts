import { ConflictException } from '@nestjs/common';
import type { Tx } from '../epi/epi-tipos';

const MENSAJE =
  'El pedido de este ticket fue anulado; no se pueden registrar documentos, PTW, SWA, entregas de EPI ni inspecciones nuevos';

/**
 * Un ticket de un pedido anulado en comercial (`ticket_ref.anulado_at`) no recibe registros nuevos: lo ya creado se conserva, pero nada más se
 * abre contra él. Si el ticket no existe no hace nada: de eso se encarga cada servicio con su propio mensaje.
 */
export async function exigirTicketActivo(
  tx: Pick<Tx, 'ticketRef'>,
  ticketId: string | null | undefined,
): Promise<void> {
  if (!ticketId) return;
  if (await tx.ticketRef.count({ where: { ticketId, anuladoAt: { not: null } } }))
    throw new ConflictException(MENSAJE);
}

/** Estado de anulación que ve el cliente: el pedido está anulado y desde cuándo y por qué (datos de `ticket_ref`). */
export interface EstadoAnulacion {
  pedidoAnulado: boolean;
  anuladoAt: Date | null;
  anuladoMotivo: string | null;
}

/**
 * Anulación de un pedido a partir de sus tickets (`ticket_ref`): está anulado cuando tiene tickets y todos lo están (la misma regla que
 * `exigirPedidoActivo`). La fecha y el motivo son los de la primera anulación; si no está anulado, ambos son `null`.
 */
export function estadoAnulacion(
  tickets: ReadonlyArray<{ anuladoAt: Date | null; anuladoMotivo: string | null }>,
): EstadoAnulacion {
  const anulados = tickets.filter((t) => t.anuladoAt !== null);
  if (tickets.length === 0 || anulados.length < tickets.length)
    return { pedidoAnulado: false, anuladoAt: null, anuladoMotivo: null };
  const primero = anulados.reduce((a, b) =>
    (b.anuladoAt as Date).getTime() < (a.anuladoAt as Date).getTime() ? b : a,
  );
  return {
    pedidoAnulado: true,
    anuladoAt: primero.anuladoAt,
    anuladoMotivo: primero.anuladoMotivo,
  };
}

/** Igual, para lo que se registra contra el pedido (no contra un ticket): se rechaza cuando todos sus tickets están anulados. */
export async function exigirPedidoActivo(
  tx: Pick<Tx, 'ticketRef'>,
  pedidoId: string,
): Promise<void> {
  const [anulados, vivos] = await Promise.all([
    tx.ticketRef.count({ where: { pedidoId, anuladoAt: { not: null } } }),
    tx.ticketRef.count({ where: { pedidoId, anuladoAt: null } }),
  ]);
  if (anulados > 0 && vivos === 0) throw new ConflictException(MENSAJE);
}
