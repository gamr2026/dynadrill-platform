import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { runInEventSpan } from '@dyn/common';
import { EventBus, type EventEnvelope } from '@dyn/messaging';
import { uuidv7 } from '@dyn/utils';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Pumping registró (o reabrió) un día del servicio como «sin operación». Datos del evento: `pedidoId`, `fecha` (yyyy-MM-dd), `activa`
 * (true al registrarlo; false si el día se reabre), `motivo` (nombre del motivo), `detalle` (texto libre, opcional), `ticketNumero`
 * (opcional).
 */
export const EVENTO_JORNADA_SIN_OPERACION = 'operaciones.pumping.jornada_sin_operacion';

const FECHA = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Guarda los días sin operación del pedido: son los días que no exigen Reporte Job para enviar la prefactura al cliente (regla de envío).
 * Reemplaza el día si ya estaba y lo quita si el evento dice que ya no está justificado. Un pedido que no existe se omite sin fallar.
 * Idempotente por el inbox.
 */
@Injectable()
export class JornadaSinOperacionConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(JornadaSinOperacionConsumer.name);

  constructor(
    private readonly bus: EventBus,
    private readonly prisma: PrismaService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.bus.subscribe({
      source: 'operaciones',
      patterns: [EVENTO_JORNADA_SIN_OPERACION],
      group: 'jornada-sin-operacion',
      handler: (e) => this.consumir(e),
    });
  }

  /** Público para poder probarlo sin RabbitMQ. */
  async consumir(event: EventEnvelope): Promise<void> {
    if (event.type !== EVENTO_JORNADA_SIN_OPERACION) return;
    await runInEventSpan(`consume ${event.type}`, event.traceparent, async () => {
      await this.prisma.$transaction(async (tx) => {
        const nuevo = await this.bus.handleOnce(tx, event, async () => {
          const d = event.data;
          const pedidoId = String(d['pedidoId'] ?? '');
          const fecha = String(d['fecha'] ?? '');
          if (!pedidoId || !FECHA.test(fecha)) {
            this.logger.warn(`${event.type}: falta el pedido o el día; se ignora`);
            return;
          }
          const dia = new Date(`${fecha}T00:00:00.000Z`);
          if (d['activa'] === false) {
            await tx.pedidoJornadaSinOperacion.deleteMany({ where: { pedidoId, fecha: dia } });
            return;
          }
          const pedido = await tx.pedido.findUnique({
            where: { id: pedidoId },
            select: { id: true },
          });
          if (!pedido) {
            this.logger.warn(`${event.type}: el pedido ${pedidoId} no existe; se ignora`);
            return;
          }
          const motivo = String(d['motivo'] ?? '').trim() || 'Sin motivo indicado';
          const detalle = d['detalle'] ? String(d['detalle']) : null;
          const ticketNumero = typeof d['ticketNumero'] === 'number' ? d['ticketNumero'] : null;
          await tx.pedidoJornadaSinOperacion.upsert({
            where: { pedidoId_fecha: { pedidoId, fecha: dia } },
            create: { id: uuidv7(), pedidoId, fecha: dia, motivo, detalle, ticketNumero },
            update: { motivo, detalle, ticketNumero },
          });
        });
        if (!nuevo) this.logger.warn(`Evento ${event.id} duplicado: se ignora`);
      });
    });
  }
}
