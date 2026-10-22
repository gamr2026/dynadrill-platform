import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { runInEventSpan } from '@dyn/common';
import { EventBus, type EventEnvelope } from '@dyn/messaging';
import { PrismaService } from '../prisma/prisma.service';
import { ReportesService } from '../services/reportes.service';

/** Evento de QHSE cuando una inspección de campo rechazada origina un reporte de unidad (contrato 4.6-bis). */
export const EVENTO_REPORTE_UNIDAD_QHSE = 'qhse.reporte_unidad.generado';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Recibe el reporte de unidad que genera QHSE (una inspección rechazada de un vehículo-grúa) y lo deja en la bandeja de clasificación con
 * origen QHSE. Lleva `casoId` (la inspección: la clave para no recibirlo dos veces), `unidadId` (de Flota) y `novedad`, el único texto que
 * se copia. Idempotente (inbox y `casoId`) y tolerante: un evento al que le falta algo, o con una unidad que no existe en Flota, se
 * registra y se ignora sin error (no hay nada que reintentar).
 */
@Injectable()
export class ReporteUnidadQhseConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(ReporteUnidadQhseConsumer.name);

  constructor(
    private readonly bus: EventBus,
    private readonly prisma: PrismaService,
    private readonly reportes: ReportesService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.bus.subscribe({
      source: 'qhse',
      patterns: [EVENTO_REPORTE_UNIDAD_QHSE],
      // su propia cola (`mantenimiento.qhse`): Pumping y FCR ya leen eventos de QHSE en este contenedor y no deben repartirse los mensajes
      group: 'mantenimiento',
      handler: (e) => this.consumir(e),
    });
  }

  /** Público para poder probarlo sin RabbitMQ. */
  async consumir(event: EventEnvelope): Promise<void> {
    if (event.type !== EVENTO_REPORTE_UNIDAD_QHSE) return;
    await runInEventSpan(`consume ${event.type}`, event.traceparent, async () => {
      await this.prisma.$transaction(async (tx) => {
        const procesado = await this.bus.handleOnce(tx, event, async () => {
          const d = event.data;
          const casoId = String(d['casoId'] ?? '');
          const unidadId = String(d['unidadId'] ?? '');
          const novedad = typeof d['novedad'] === 'string' ? d['novedad'] : '';
          if (!UUID.test(casoId) || !UUID.test(unidadId) || !novedad.trim()) {
            this.logger.warn(`${event.type}: faltan casoId, unidadId o novedad; se ignora`);
            return;
          }
          const ticketId =
            typeof d['ticketId'] === 'string' && UUID.test(d['ticketId']) ? d['ticketId'] : null;
          const id = await this.reportes.recibirDeQhse(
            tx,
            { casoId, unidadId, novedad, ticketId },
            event.actor?.userId ?? null,
          );
          this.logger.log(
            id
              ? `Reporte de unidad de QHSE recibido (${id})`
              : `Caso ${casoId} de QHSE: no corresponde recibirlo`,
          );
        });
        if (!procesado) this.logger.warn(`Evento ${event.id} duplicado: se ignora`);
      });
    });
  }
}
