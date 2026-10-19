import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { runInEventSpan } from '@dyn/common';
import { EventBus, type EventEnvelope } from '@dyn/messaging';
import { PrismaService } from '../prisma/prisma.service';
import { CambiosItemsService } from '../services/cambios-items.service';

export const EVENTO_RESULTADO = 'comercial.cambio_items.resultado';

/**
 * Comercial responde si pudo aplicar el cambio de ítems que aprobó el Supervisor (o por qué no, p. ej. el pedido ya salió al cliente
 * para firmas). El ticket lo guarda en la solicitud para mostrarlo. Idempotente por el inbox y porque solo cierra lo pendiente.
 */
@Injectable()
export class ResultadoCambioItemsConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(ResultadoCambioItemsConsumer.name);

  constructor(
    private readonly bus: EventBus,
    private readonly prisma: PrismaService,
    private readonly cambios: CambiosItemsService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.bus.subscribe({
      source: 'comercial',
      patterns: [EVENTO_RESULTADO],
      group: 'cambio-items',
      handler: (e) => this.consumir(e),
    });
  }

  /** Público para poder probarlo sin RabbitMQ. */
  async consumir(event: EventEnvelope): Promise<void> {
    if (event.type !== EVENTO_RESULTADO) return;
    await runInEventSpan(`consume ${event.type}`, event.traceparent, async () => {
      await this.prisma.$transaction(async (tx) => {
        const nuevo = await this.bus.handleOnce(tx, event, async () => {
          const id = String(event.data['solicitudId'] ?? '');
          if (!id) return;
          await this.cambios.registrarResultado(
            tx,
            id,
            event.data['aplicado'] === true,
            event.data['motivo'] ? String(event.data['motivo']) : null,
          );
        });
        if (!nuevo) this.logger.warn(`Evento ${event.id} duplicado: se ignora`);
      });
    });
  }
}
