import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { runInEventSpan } from '@dyn/common';
import { EventBus, type EventEnvelope } from '@dyn/messaging';
import { PrismaService } from '../prisma/prisma.service';
import { HerramientasService } from '../services/herramientas.service';

export const EVENTO_DESPACHO_REALIZADO = 'operaciones.inventario.despacho.realizado';
export const EVENTO_DESPACHO_RECHAZADO = 'operaciones.inventario.despacho.rechazado';
const EVENTOS = [EVENTO_DESPACHO_REALIZADO, EVENTO_DESPACHO_RECHAZADO];

/**
 * Bodega resolvió en Inventario la solicitud de despacho de un ticket de FCR. Despachado: las herramientas solicitadas quedan preparadas, enviadas
 * y recibidas (el despacho físico de Bodega es lo que hace avanzar el ticket) y el ticket continúa. Rechazado: vuelven a «sin solicitar» con el
 * motivo, para que el Supervisor las ajuste y las pida de nuevo. Solo atiende los despachos con origen FCR. Idempotente por el inbox.
 */
@Injectable()
export class DespachoResultadoConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(DespachoResultadoConsumer.name);

  constructor(
    private readonly bus: EventBus,
    private readonly prisma: PrismaService,
    private readonly herramientas: HerramientasService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.bus.subscribe({
      source: 'operaciones',
      patterns: EVENTOS,
      group: 'despachos-fcr',
      handler: (e) => this.consumir(e),
    });
  }

  /** Público para poder probarlo sin RabbitMQ. */
  async consumir(event: EventEnvelope): Promise<void> {
    if (!EVENTOS.includes(event.type)) return;
    if (event.data['origen'] !== 'fcr' || !event.data['ticketFcrId']) return;
    await runInEventSpan(`consume ${event.type}`, event.traceparent, async () => {
      await this.prisma.$transaction(async (tx) => {
        const nuevo = await this.bus.handleOnce(tx, event, async () => {
          const ticketId = String(event.data['ticketFcrId']);
          const actorId = event.actor?.userId;
          if (!actorId) {
            this.logger.warn(`${event.type}: falta quién resolvió; se ignora`);
            return;
          }
          if (event.type === EVENTO_DESPACHO_REALIZADO) {
            await this.herramientas.alDespacharBodega(tx, ticketId, actorId);
          } else {
            await this.herramientas.alRechazarBodega(
              tx,
              ticketId,
              actorId,
              String(event.data['motivo'] ?? 'Sin motivo'),
            );
          }
        });
        if (!nuevo) this.logger.warn(`Evento ${event.id} duplicado: se ignora`);
      });
    });
  }
}
