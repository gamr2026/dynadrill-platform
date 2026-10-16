import { ConflictException, Injectable } from '@nestjs/common';
import type { AuthUser } from '@dyn/common';
import type { Prisma } from '../generated/client';
import { ActorFlujo, WorkflowService } from '../workflow/workflow.service';

export const PROCESO_PEDIDO = 'pedido';

export const actorDeFlujo = (a: AuthUser): ActorFlujo => ({
  id: a.id,
  nombre: a.name,
  rol: a.roleCode,
  permisos: a.permissions,
});

/**
 * Cambia el estado del pedido por un hecho del ciclo (documento recibido, prefactura generada, enviada, firmada...).
 * Valida el paso en el motor de estados, deja el seguimiento con origen "automático" (con la persona que lo causó) y
 * actualiza el pedido con comparación de estado, todo en la transacción de quien llama.
 */
@Injectable()
export class PedidoEstadoService {
  constructor(private readonly workflow: WorkflowService) {}

  async pasar(
    tx: Prisma.TransactionClient,
    pedidoId: string,
    desde: string,
    hacia: string,
    actor: AuthUser,
    motivo?: string,
  ): Promise<void> {
    await this.workflow.aplicar(tx, {
      proceso: PROCESO_PEDIDO,
      entidadId: pedidoId,
      desde,
      hacia,
      motivo,
      actor: actorDeFlujo(actor),
      origen: 'automatico',
    });
    const r = await tx.pedido.updateMany({
      where: { id: pedidoId, estado: desde },
      data: { estado: hacia, version: { increment: 1 }, updatedBy: actor.id },
    });
    if (r.count === 0)
      throw new ConflictException('El pedido cambió de estado; vuelva a intentarlo');
  }
}
