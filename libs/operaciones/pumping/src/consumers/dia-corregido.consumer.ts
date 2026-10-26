import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { runInEventSpan } from '@dyn/common';
import { EventBus, type EventEnvelope } from '@dyn/messaging';
import { PrismaService } from '../prisma/prisma.service';
import { ReportesDiariosService } from '../services/reportes-diarios.service';

export const EVENTO_DIA_CORREGIDO = 'comercial.documento_operativo.corregido';

/**
 * Facturación corrigió un día del Reporte Job en el pedido: el ticket de Pumping deja de poder editarlo y reenviarlo (contrato 4.4).
 * Solo cuenta lo de origen `pumping`; el de FCR no es de este módulo. Idempotente por el inbox.
 */
@Injectable()
export class DiaCorregidoConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(DiaCorregidoConsumer.name);

  constructor(
    private readonly bus: EventBus,
    private readonly prisma: PrismaService,
    private readonly reportes: ReportesDiariosService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.bus.subscribe({
      source: 'comercial',
      patterns: [EVENTO_DIA_CORREGIDO],
      // su propia cola: otros consumidores del contenedor leen eventos de comercial y no deben repartirse los mensajes con este
      group: 'reportes-diarios',
      handler: (e) => this.consumir(e),
    });
  }

  /** Público para poder probarlo sin RabbitMQ. */
  async consumir(event: EventEnvelope): Promise<void> {
    if (event.type !== EVENTO_DIA_CORREGIDO) return;
    await runInEventSpan(`consume ${event.type}`, event.traceparent, async () => {
      await this.prisma.$transaction(async (tx) => {
        const nuevo = await this.bus.handleOnce(tx, event, async () => {
          if (event.data['origen'] !== 'pumping') return;
          await this.reportes.marcarCorregido(
            tx,
            String(event.data['pedidoId'] ?? ''),
            String(event.data['fecha'] ?? ''),
            event.actor?.userId,
          );
        });
        if (!nuevo) this.logger.warn(`Evento ${event.id} duplicado: se ignora`);
      });
    });
  }
}
