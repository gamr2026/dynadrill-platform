import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { runInEventSpan } from '@dyn/common';
import { EventBus, type EventEnvelope } from '@dyn/messaging';
import type { Prisma } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import { ReporteHerramientasService } from '../services/reporte-herramientas.service';
import { PedidoAbiertoData, TicketsService } from '../services/tickets.service';

/**
 * Recibe los pedidos que Ventas abre en `comercial`. Si son de la línea Pumping, crea su ticket. El inbox evita crearlo
 * dos veces si el evento se entrega repetido, y todo ocurre en una sola transacción.
 */
@Injectable()
export class PedidosAbiertosConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(PedidosAbiertosConsumer.name);

  constructor(
    private readonly bus: EventBus,
    private readonly prisma: PrismaService,
    private readonly tickets: TicketsService,
    private readonly reporte: ReporteHerramientasService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.bus.subscribe({
      source: 'comercial',
      patterns: ['comercial.pedido.abierto', 'comercial.pedido.actualizado'],
      handler: (event) => this.consumir(event),
    });
  }

  /** Público para poder probarlo sin RabbitMQ. */
  async consumir(event: EventEnvelope): Promise<void> {
    await runInEventSpan(`consume ${event.type}`, event.traceparent, async () => {
      await this.prisma.$transaction(async (tx) => {
        const procesado = await this.bus.handleOnce(tx, event, async () => {
          if (event.type === 'comercial.pedido.actualizado') return this.actualizar(tx, event);
          const r = await this.tickets.crearDesdePedido(
            tx,
            event as unknown as EventEnvelope<PedidoAbiertoData>,
          );
          if (r) {
            const lineas = (event.data as unknown as PedidoAbiertoData).lineas;
            await this.reporte.guardarLineas(tx, r.ticketId, Array.isArray(lineas) ? lineas : []);
            this.logger.log(`Pedido ${String(event.data['codigo'])}: ticket creado`);
          }
        });
        if (!procesado) this.logger.warn(`Evento ${event.id} duplicado: se ignora`);
      });
    });
  }

  /**
   * Un pedido abierto cambió (`comercial.pedido.actualizado`): el ticket toma las fechas del servicio y, si cambiaron los ítems, las líneas
   * cotizadas vigentes. Un ticket ya cerrado no se toca.
   */
  private async actualizar(tx: Prisma.TransactionClient, event: EventEnvelope): Promise<void> {
    const t = await tx.ticket.findUnique({
      where: { pedidoId: event.subject.id },
      select: { id: true, paso: { select: { terminal: true } } },
    });
    if (!t || t.paso.terminal) return;
    const d = event.data as unknown as PedidoAbiertoData;
    const deDia = (f: string | null) => (f ? new Date(`${f}T00:00:00.000Z`) : null);
    const fechas = {
      ...(d.fechaInicioServicio !== undefined
        ? { fechaInicioServicio: deDia(d.fechaInicioServicio) }
        : {}),
      ...(d.fechaFinServicio !== undefined ? { fechaFinServicio: deDia(d.fechaFinServicio) } : {}),
    };
    if (Object.keys(fechas).length) await tx.ticket.update({ where: { id: t.id }, data: fechas });
    if (Array.isArray(d.lineas)) await this.reporte.guardarLineas(tx, t.id, d.lineas);
  }
}
