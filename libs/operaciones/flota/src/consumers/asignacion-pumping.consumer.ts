import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { runInEventSpan } from '@dyn/common';
import { EventBus, type EventEnvelope } from '@dyn/messaging';
import { uuidv7 } from '@dyn/utils';
import { PrismaService } from '../prisma/prisma.service';

/** Evento de Pumping al asignar el equipo de un ticket (contrato 4.7). */
export const EVENTO_ASIGNACION_PUMPING = 'operaciones.pumping.asignacion_realizada';

interface Emparejamiento {
  usuarioId: string;
  vehiculoId: string;
}

const esEmparejamiento = (x: unknown): x is Emparejamiento =>
  typeof x === 'object' &&
  x !== null &&
  typeof (x as Emparejamiento).usuarioId === 'string' &&
  typeof (x as Emparejamiento).vehiculoId === 'string';

/**
 * Abre el caso de inspección de vehículos de cada unidad de transporte que Pumping asigna a un ticket (decisión D8: las demás
 * unidades no se inspeccionan). Idempotente: una nueva asignación del mismo ticket actualiza el operador de cada caso y retira los
 * casos de unidades que ya no están y no tienen inspecciones. Un evento al que le falta algo se ignora sin error.
 */
@Injectable()
export class AsignacionPumpingConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(AsignacionPumpingConsumer.name);

  constructor(
    private readonly bus: EventBus,
    private readonly prisma: PrismaService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.bus.subscribe({
      source: 'operaciones',
      // Otros módulos de operaciones ya consumen eventos de este origen: el grupo propio evita que se repartan los mensajes.
      group: 'flota',
      patterns: [EVENTO_ASIGNACION_PUMPING],
      handler: (e) => this.consumir(e),
    });
  }

  /** Público para poder probarlo sin RabbitMQ. */
  async consumir(event: EventEnvelope): Promise<void> {
    if (event.type !== EVENTO_ASIGNACION_PUMPING) return;
    await runInEventSpan(`consume ${event.type}`, event.traceparent, async () => {
      await this.prisma.$transaction(async (tx) => {
        const procesado = await this.bus.handleOnce(tx, event, async () => {
          const ticketId = String(event.data['ticketId'] ?? '');
          const pares = Array.isArray(event.data['operadoresUnidades'])
            ? event.data['operadoresUnidades'].filter(esEmparejamiento)
            : [];
          if (!ticketId) {
            this.logger.warn(`${event.type}: falta ticketId; se ignora`);
            return;
          }
          if (!(await tx.pumTicket.findUnique({ where: { id: ticketId }, select: { id: true } }))) {
            this.logger.warn(`${event.type}: el ticket ${ticketId} no existe; se ignora`);
            return;
          }
          const actorId = event.actor?.userId ?? null;
          const vigentes: string[] = [];
          for (const par of pares) {
            const unidad = await tx.unidad.findFirst({
              where: { vehiculoId: par.vehiculoId, tipo: 'transporte', activa: true },
              select: { id: true },
            });
            if (!unidad) continue; // no es una unidad de transporte de Flota: no hay inspección que abrir
            vigentes.push(unidad.id);
            await tx.inspeccionCaso.upsert({
              where: { ticketId_unidadId: { ticketId, unidadId: unidad.id } },
              create: {
                id: uuidv7(),
                ticketId,
                unidadId: unidad.id,
                operadorId: par.usuarioId,
                createdBy: actorId,
                updatedBy: actorId,
              },
              update: { operadorId: par.usuarioId, updatedBy: actorId, updatedAt: new Date() },
            });
          }
          const retirados = await tx.inspeccionCaso.deleteMany({
            where: { ticketId, unidadId: { notIn: vigentes }, inspecciones: { none: {} } },
          });
          this.logger.log(
            `Ticket ${ticketId}: ${vigentes.length} caso(s) de inspección, ${retirados.count} retirado(s)`,
          );
        });
        if (!procesado) this.logger.warn(`Evento ${event.id} duplicado: se ignora`);
      });
    });
  }
}
