import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { runInEventSpan } from '@dyn/common';
import { EventBus, type EventEnvelope } from '@dyn/messaging';
import { PrismaService } from '../prisma/prisma.service';
import { PedidoAbiertoData, TicketsService } from '../services/tickets.service';

/**
 * Recibe los pedidos que Ventas abre en `comercial`. Si son de la línea Pumping, crea su ticket. El inbox evita crearlo
 * dos veces si el evento se entrega repetido, y todo ocurre en una sola transacción.
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
      patterns: ['comercial.pedido.abierto'],
      handler: (event) => this.consumir(event),
    });
  }

  /** Público para poder probarlo sin RabbitMQ. */
  async consumir(event: EventEnvelope): Promise<void> {
    await runInEventSpan(`consume ${event.type}`, event.traceparent, async () => {
      await this.prisma.$transaction(async (tx) => {
        const procesado = await this.bus.handleOnce(tx, event, async () => {
          const r = await this.tickets.crearDesdePedido(
            tx,
            event as unknown as EventEnvelope<PedidoAbiertoData>,
          );
          if (r) this.logger.log(`Pedido ${String(event.data['codigo'])}: ticket creado`);
        });
        if (!procesado) this.logger.warn(`Evento ${event.id} duplicado: se ignora`);
      });
    });
  }
}
