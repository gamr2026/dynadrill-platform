import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { runInEventSpan } from '@dyn/common';
import { EventBus, type EventEnvelope } from '@dyn/messaging';
import { PrismaService } from '../prisma/prisma.service';
import { ReportesService } from '../services/reportes.service';

/** Evento de Pumping al firmarse la llegada de la unidad (contrato 4.2). */
export const EVENTO_LLEGADA_PUMPING = 'operaciones.pumping.reporte_unidad_llegada';

/**
 * Recibe el reporte de unidad de llegada de Pumping y, si trae novedades, lo deja en la bandeja de clasificación. Lleva `ticketId`,
 * `vehiculoId`, `reporteUnidadId` y `hayNovedades`; el contenido se lee del reporte de Pumping (mismo contenedor), no del evento.
 * Idempotente (inbox) y tolerante: un evento al que le falta algo se ignora sin error.
 */
@Injectable()
export class ReporteUnidadLlegadaConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(ReporteUnidadLlegadaConsumer.name);

  constructor(
    private readonly bus: EventBus,
    private readonly prisma: PrismaService,
    private readonly reportes: ReportesService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.bus.subscribe({
      source: 'operaciones',
      patterns: [EVENTO_LLEGADA_PUMPING],
      handler: (e) => this.consumir(e),
    });
  }

  /** Público para poder probarlo sin RabbitMQ. */
  async consumir(event: EventEnvelope): Promise<void> {
    if (event.type !== EVENTO_LLEGADA_PUMPING) return;
    await runInEventSpan(`consume ${event.type}`, event.traceparent, async () => {
      await this.prisma.$transaction(async (tx) => {
        const procesado = await this.bus.handleOnce(tx, event, async () => {
          const reporteUnidadId = String(event.data['reporteUnidadId'] ?? '');
          if (!reporteUnidadId) {
            this.logger.warn(`${event.type}: falta reporteUnidadId; se ignora`);
            return;
          }
          if (event.data['hayNovedades'] === false) return;
          const id = await this.reportes.recibirDePumping(
            tx,
            reporteUnidadId,
            event.actor?.userId ?? null,
          );
          this.logger.log(
            id
              ? `Reporte de unidad recibido (${id})`
              : `Reporte ${reporteUnidadId}: no corresponde recibirlo`,
          );
        });
        if (!procesado) this.logger.warn(`Evento ${event.id} duplicado: se ignora`);
      });
    });
  }
}
