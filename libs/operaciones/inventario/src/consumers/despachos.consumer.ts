import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { runInEventSpan } from '@dyn/common';
import { EventBus, type EventEnvelope } from '@dyn/messaging';
import { PrismaService } from '../prisma/prisma.service';
import { DespachosService } from '../services/despachos.service';

/**
 * Recibe los despachos a bodega que publica el ciclo comercial. El inbox evita procesar dos veces el mismo evento y todo ocurre
 * en una sola transacción.
 */
@Injectable()
export class DespachosConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(DespachosConsumer.name);

  constructor(
    private readonly bus: EventBus,
    private readonly prisma: PrismaService,
    private readonly despachos: DespachosService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // un ticket de FCR que solicita sus herramientas pide a Bodega la guía de remisión
    await this.bus.subscribe({
      source: 'operaciones',
      group: 'inventario-fcr',
      patterns: ['operaciones.fcr.herramientas_solicitadas'],
      handler: (event) => this.consumir(event),
    });
    await this.bus.subscribe({
      source: 'comercial',
      // Pumping también consume de comercial en este contenedor: sin grupo propio compartirían la cola y se perderían eventos
      group: 'inventario',
      patterns: ['comercial.despacho.solicitado'],
      handler: (event) => this.consumir(event),
    });
  }

  /** Público para poder probarlo sin RabbitMQ. */
  async consumir(event: EventEnvelope): Promise<void> {
    await runInEventSpan(`consume ${event.type}`, event.traceparent, async () => {
      await this.prisma.$transaction(async (tx) => {
        const procesado = await this.bus.handleOnce(tx, event, async () => {
          if (event.type === 'comercial.despacho.solicitado')
            await this.despachos.alSolicitar(tx, event);
          if (event.type === 'operaciones.fcr.herramientas_solicitadas')
            await this.despachos.alSolicitarFcr(tx, event);
        });
        if (!procesado) this.logger.warn(`Evento ${event.id} duplicado: se ignora`);
      });
    });
  }
}
