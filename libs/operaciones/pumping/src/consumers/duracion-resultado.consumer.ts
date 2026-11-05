import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { runInEventSpan } from '@dyn/common';
import { EventBus, type EventEnvelope } from '@dyn/messaging';
import { PrismaService } from '../prisma/prisma.service';
import { DuracionService } from '../services/duracion.service';

export const EVENTO_DURACION_RECHAZADA = 'comercial.duracion_servicio.rechazada';

/**
 * Comercial no pudo aplicar al pedido el cambio de duración que decidió el Jefe de Base (p. ej. el pedido ya salió al cliente para firmas): el
 * ticket vuelve a la fecha de fin anterior para no quedar distinto del pedido. Idempotente por el inbox y porque solo revierte si el ticket todavía
 * tiene la fecha que se cambió.
 */
@Injectable()
export class DuracionResultadoConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(DuracionResultadoConsumer.name);

  constructor(
    private readonly bus: EventBus,
    private readonly prisma: PrismaService,
    private readonly duracion: DuracionService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.bus.subscribe({
      source: 'comercial',
      patterns: [EVENTO_DURACION_RECHAZADA],
      group: 'duracion-servicio',
      handler: (e) => this.consumir(e),
    });
  }

  /** Público para poder probarlo sin RabbitMQ. */
  async consumir(event: EventEnvelope): Promise<void> {
    if (event.type !== EVENTO_DURACION_RECHAZADA) return;
    await runInEventSpan(`consume ${event.type}`, event.traceparent, async () => {
      await this.prisma.$transaction(async (tx) => {
        const nuevo = await this.bus.handleOnce(tx, event, async () => {
          const d = event.data;
          const ticketId = String(d['ticketId'] ?? '');
          if (!ticketId) {
            this.logger.warn(`${event.type}: falta el ticket; se ignora`);
            return;
          }
          const revertido = await this.duracion.revertir(
            tx,
            ticketId,
            String(d['fechaFinNueva'] ?? ''),
            String(d['fechaFinAnterior'] ?? ''),
            String(d['motivo'] ?? 'sin motivo'),
          );
          this.logger.log(
            `Ticket ${ticketId}: cambio de duración ${revertido ? 'revertido' : 'sin nada que revertir'}`,
          );
        });
        if (!nuevo) this.logger.warn(`Evento ${event.id} duplicado: se ignora`);
      });
    });
  }
}
