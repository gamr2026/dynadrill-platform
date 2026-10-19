import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { runInEventSpan } from '@dyn/common';
import { EventBus, type EventEnvelope } from '@dyn/messaging';
import { REQ } from '../catalog/sembrar-pasos';
import { PrismaService } from '../prisma/prisma.service';
import { RequisitosService } from '../services/requisitos.service';

/** Eventos de QHSE (contrato 4.11): el Acta de Entrega de Locación se cargó o se anuló. Se aceptan los dos nombres del cargado. */
export const EVENTOS_ACTA = {
  cumplir: ['qhse.acta_entrega.cargada', 'qhse.documento.acta_entrega_cargada'],
  reabrir: ['qhse.acta_entrega.anulada'],
} as const;
const TODOS = [...EVENTOS_ACTA.cumplir, ...EVENTOS_ACTA.reabrir] as string[];

/**
 * El cierre del ticket exige el Acta de Entrega de Locación que QHSE carga (requisito `acta_entrega_locacion`). QHSE publica
 * `ticketId`; si el ticket no es de FCR (es de Pumping) o no existe, se ignora sin error. Si QHSE aún no lo publica, el puente temporal
 * (`fcr.requisitos.puente`, con motivo) cumple el requisito. Idempotente por el inbox.
 */
@Injectable()
export class ActaEntregaConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(ActaEntregaConsumer.name);

  constructor(
    private readonly bus: EventBus,
    private readonly prisma: PrismaService,
    private readonly requisitos: RequisitosService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.bus.subscribe({
      source: 'qhse',
      patterns: TODOS,
      // su propia cola: Pumping ya lee eventos de QHSE en este contenedor y no deben repartirse los mensajes
      group: 'fcr',
      handler: (e) => this.consumir(e),
    });
  }

  /** Público para poder probarlo sin RabbitMQ. */
  async consumir(event: EventEnvelope): Promise<void> {
    if (!TODOS.includes(event.type)) return;
    await runInEventSpan(`consume ${event.type}`, event.traceparent, async () => {
      await this.prisma.$transaction(async (tx) => {
        const nuevo = await this.bus.handleOnce(tx, event, async () => {
          const ticketId = String(event.data['ticketId'] ?? '');
          if (!ticketId) {
            this.logger.warn(`${event.type}: falta el ticketId; se ignora`);
            return;
          }
          const clave = { ticketId, codigo: REQ.actaEntregaLocacion };
          const n = (EVENTOS_ACTA.cumplir as readonly string[]).includes(event.type)
            ? await this.requisitos.marcar(tx, clave, 'evento', event.actor?.userId ?? null)
            : await this.requisitos.reabrir(tx, clave);
          this.logger.log(`${event.type}: ${n} requisito(s) del Acta de Entrega actualizado(s)`);
        });
        if (!nuevo) this.logger.warn(`Evento ${event.id} duplicado: se ignora`);
      });
    });
  }
}
