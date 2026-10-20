import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { runInEventSpan } from '@dyn/common';
import { EventBus, type EventEnvelope } from '@dyn/messaging';
import { PrismaService } from '../prisma/prisma.service';

/** Eventos con los que Operaciones abre un ticket y lo mueve de paso (Pumping y FCR). */
export const EVENTOS_TICKET_OPERATIVO = [
  'operaciones.pumping.ticket_creado',
  'operaciones.pumping.paso_cambiado',
  'operaciones.fcr.ticket_creado',
  'operaciones.fcr.paso_cambiado',
] as const;

/** Paso con el que nace cada ticket (el de Pumping siempre empieza en la revisión inicial). */
const PASO_INICIAL_PUMPING = 'revision_inicial';

/**
 * Mantiene, por pedido, el ticket de Operaciones que lo atiende y el código del paso en que va, para que Facturación vea la fase
 * sin entrar a Operaciones. Solo guarda el código (el nombre es del catálogo de Operaciones). Idempotente por el inbox; si el pedido
 * no existe (o el evento llegó antes que él) se ignora sin fallar.
 */
@Injectable()
export class TicketOperativoConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(TicketOperativoConsumer.name);

  constructor(
    private readonly bus: EventBus,
    private readonly prisma: PrismaService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.bus.subscribe({
      source: 'operaciones',
      group: 'comercial-ticket-operativo',
      patterns: [...EVENTOS_TICKET_OPERATIVO],
      handler: (e) => this.consumir(e),
    });
  }

  /** Público para poder probarlo sin RabbitMQ. */
  async consumir(event: EventEnvelope): Promise<void> {
    if (!(EVENTOS_TICKET_OPERATIVO as readonly string[]).includes(event.type)) return;
    await runInEventSpan(`consume ${event.type}`, event.traceparent, async () => {
      await this.prisma.$transaction(async (tx) => {
        const nuevo = await this.bus.handleOnce(tx, event, async () => {
          const pedidoId = String(event.data['pedidoId'] ?? '');
          const ticketId = String(event.data['ticketId'] ?? '');
          const origen = event.type.startsWith('operaciones.fcr.')
            ? ('fcr' as const)
            : ('pumping' as const);
          const paso = String(
            (event.type.endsWith('.paso_cambiado')
              ? event.data['hacia']
              : (event.data['paso'] ?? (origen === 'pumping' ? PASO_INICIAL_PUMPING : ''))) ?? '',
          );
          if (!pedidoId || !ticketId || !paso) {
            this.logger.warn(`${event.type}: faltan pedidoId, ticketId o paso; se ignora`);
            return;
          }
          if (!(await tx.pedido.findUnique({ where: { id: pedidoId }, select: { id: true } }))) {
            this.logger.warn(`${event.type}: el pedido ${pedidoId} no existe; se ignora`);
            return;
          }
          // el ticket recién creado no pisa un paso que ya llegó (si los eventos se cruzaron)
          if (event.type.endsWith('.ticket_creado')) {
            const previo = await tx.pedidoTicketOperativo.findUnique({
              where: { pedidoId },
              select: { pedidoId: true },
            });
            if (previo) return;
          }
          await tx.pedidoTicketOperativo.upsert({
            where: { pedidoId },
            create: { pedidoId, origen, ticketId, pasoCodigo: paso },
            update: { origen, ticketId, pasoCodigo: paso, actualizadoAt: new Date() },
          });
        });
        if (!nuevo) this.logger.warn(`Evento ${event.id} duplicado: se ignora`);
      });
    });
  }
}
