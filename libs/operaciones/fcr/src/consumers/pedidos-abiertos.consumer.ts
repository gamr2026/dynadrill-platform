import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { runInEventSpan } from '@dyn/common';
import { EventBus, type EventEnvelope } from '@dyn/messaging';
import { PrismaService } from '../prisma/prisma.service';
import { PedidoAbiertoData, TicketsService } from '../services/tickets.service';

export const EVENTO_PEDIDO_ABIERTO = 'comercial.pedido.abierto';
export const EVENTO_PEDIDO_ACTUALIZADO = 'comercial.pedido.actualizado';

/**
 * Recibe los eventos del pedido que Ventas lleva en `comercial`: si se abre un pedido de la línea FCR crea su ticket, y si un pedido ya
 * abierto cambia (fechas del servicio, ítems) actualiza el del ticket. Los dos van en una sola suscripción (una sola cola del grupo `fcr`).
 * El inbox evita procesar dos veces un evento entregado repetido, y todo ocurre en una sola transacción.
 */
@Injectable()
export class PedidosAbiertosConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(PedidosAbiertosConsumer.name);

  constructor(
    private readonly bus: EventBus,
    private readonly prisma: PrismaService,
    private readonly tickets: TicketsService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.bus.subscribe({
      source: 'comercial',
      patterns: [EVENTO_PEDIDO_ABIERTO, EVENTO_PEDIDO_ACTUALIZADO],
      // su propia cola: Pumping e Inventario ya leen eventos de comercial en este contenedor y no deben repartirse los mensajes
      group: 'fcr',
      handler: (event) => this.consumir(event),
    });
  }

  /** Público para poder probarlo sin RabbitMQ. */
  async consumir(event: EventEnvelope): Promise<void> {
    if (event.type !== EVENTO_PEDIDO_ABIERTO && event.type !== EVENTO_PEDIDO_ACTUALIZADO) return;
    await runInEventSpan(`consume ${event.type}`, event.traceparent, async () => {
      await this.prisma.$transaction(async (tx) => {
        const procesado = await this.bus.handleOnce(tx, event, async () => {
          if (event.type === EVENTO_PEDIDO_ABIERTO) {
            const r = await this.tickets.crearDesdePedido(
              tx,
              event as unknown as EventEnvelope<PedidoAbiertoData>,
            );
            if (r) this.logger.log(`Pedido ${String(event.data['codigo'])}: ticket creado`);
            return;
          }
          const actualizado = await this.tickets.actualizarDesdePedido(
            tx,
            event as unknown as EventEnvelope<Partial<PedidoAbiertoData>>,
          );
          if (actualizado)
            this.logger.log(`Pedido ${String(event.data['codigo'])}: ticket actualizado`);
        });
        if (!procesado) this.logger.warn(`Evento ${event.id} duplicado: se ignora`);
      });
    });
  }
}
