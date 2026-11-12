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
