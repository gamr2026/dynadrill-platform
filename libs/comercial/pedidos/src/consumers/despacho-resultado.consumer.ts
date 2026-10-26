import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { runInEventSpan, type AuthUser } from '@dyn/common';
import { EventBus, type EventEnvelope } from '@dyn/messaging';
import { PrismaService } from '../prisma/prisma.service';
import { PedidoEstadoService } from '../services/pedido-estado.service';

export const EVENTO_DESPACHO_REALIZADO = 'operaciones.inventario.despacho.realizado';
export const EVENTO_DESPACHO_RECHAZADO = 'operaciones.inventario.despacho.rechazado';
const EVENTOS = [EVENTO_DESPACHO_REALIZADO, EVENTO_DESPACHO_RECHAZADO];

/**
 * Bodega resolvió en Inventario la solicitud de despacho (CM-5): despachada o rechazada. En ambos casos el pedido vuelve de
 * `por_despachar_bodega` a `prefactura_generada` (rechazada, Facturación puede corregir y pedir de nuevo). Si el pedido ya no está
 * esperando el despacho, se registra y se omite. Idempotente por el inbox.
 */
@Injectable()
export class DespachoResultadoConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(DespachoResultadoConsumer.name);

  constructor(
    private readonly bus: EventBus,
    private readonly prisma: PrismaService,
    private readonly estados: PedidoEstadoService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.bus.subscribe({
      source: 'operaciones',
      patterns: EVENTOS,
      group: 'despachos',
      handler: (e) => this.consumir(e),
    });
  }

  /** Público para poder probarlo sin RabbitMQ. */
  async consumir(event: EventEnvelope): Promise<void> {
    if (!EVENTOS.includes(event.type)) return;
    await runInEventSpan(`consume ${event.type}`, event.traceparent, async () => {
      await this.prisma.$transaction(async (tx) => {
        const nuevo = await this.bus.handleOnce(tx, event, async () => {
          const pedidoId = String(event.data['pedidoId'] ?? '');
          const userId = event.actor?.userId;
          if (!pedidoId || !userId) {
            this.logger.warn(`${event.type}: falta el pedido o quién resolvió; se ignora`);
            return;
          }
          const p = await tx.pedido.findUnique({
            where: { id: pedidoId },
            select: { estado: true },
          });
          if (p?.estado !== 'por_despachar_bodega') {
            this.logger.warn(
              `${event.type}: el pedido ${pedidoId} no espera un despacho (${p?.estado ?? 'no existe'}); se omite`,
            );
            return;
          }
          const actor = {
            id: userId,
            roleCode: event.actor?.role ?? 'bodeguero',
          } as unknown as AuthUser;
          const numero = event.data['numero'];
          const motivo =
            event.type === EVENTO_DESPACHO_REALIZADO
              ? `despacho ${numero} realizado`
              : `despacho ${numero} rechazado: ${String(event.data['motivo'] ?? '')}`;
          await this.estados.pasar(
            tx,
            pedidoId,
            'por_despachar_bodega',
            'prefactura_generada',
            actor,
            motivo,
          );
        });
        if (!nuevo) this.logger.warn(`Evento ${event.id} duplicado: se ignora`);
      });
    });
  }
}
