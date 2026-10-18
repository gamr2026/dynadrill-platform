import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { runInEventSpan } from '@dyn/common';
import { EventBus, type EventEnvelope } from '@dyn/messaging';
import { PrismaService } from '../prisma/prisma.service';
import { BitacoraService } from '../services/bitacora.service';
import { PedidoAbiertoData, TicketsService } from '../services/tickets.service';

export const EVENTO_PEDIDO_ABIERTO = 'comercial.pedido.abierto';
export const EVENTO_PEDIDO_ACTUALIZADO = 'comercial.pedido.actualizado';
/** Facturación corrigió un día del Reporte Job en el pedido: el ticket deja de poder editarlo y reenviarlo (contrato 4.4). */
export const EVENTO_DIA_CORREGIDO = 'comercial.documento_operativo.corregido';
const EVENTOS = [EVENTO_PEDIDO_ABIERTO, EVENTO_PEDIDO_ACTUALIZADO, EVENTO_DIA_CORREGIDO];

/**
 * Recibe los eventos del pedido que Ventas lleva en `comercial`: si se abre un pedido de la línea FCR crea su ticket, y si un pedido ya
 * abierto cambia (fechas del servicio, ítems) actualiza el del ticket. Los dos van en una sola suscripción (una sola cola del grupo `fcr`).
 * El inbox evita procesar dos veces un evento entregado repetido, y todo ocurre en una sola transacción.
 */
@Injectable()
export class PedidosAbiertosConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(PedidosAbiertosConsumer.name);

  constructor(
    private readonly bus: EventBus,
    private readonly prisma: PrismaService,
    private readonly tickets: TicketsService,
    private readonly bitacora: BitacoraService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.bus.subscribe({
      source: 'comercial',
      patterns: EVENTOS,
      // su propia cola: Pumping e Inventario ya leen eventos de comercial en este contenedor y no deben repartirse los mensajes
      group: 'fcr',
      handler: (event) => this.consumir(event),
    });
  }

  /** Público para poder probarlo sin RabbitMQ. */
  async consumir(event: EventEnvelope): Promise<void> {
    if (!EVENTOS.includes(event.type)) return;
    await runInEventSpan(`consume ${event.type}`, event.traceparent, async () => {
      await this.prisma.$transaction(async (tx) => {
        const procesado = await this.bus.handleOnce(tx, event, async () => {
          if (event.type === EVENTO_PEDIDO_ABIERTO) {
            const r = await this.tickets.crearDesdePedido(
              tx,
              event as unknown as EventEnvelope<PedidoAbiertoData>,
            );
            if (r) this.logger.log(`Pedido ${String(event.data['codigo'])}: ticket creado`);
            return;
          }
          if (event.type === EVENTO_DIA_CORREGIDO) {
            // solo cuenta lo de origen FCR; el de Pumping no es de este módulo
            if (event.data['origen'] === 'fcr') {
              await this.bitacora.marcarCorregida(
                tx,
                String(event.data['pedidoId'] ?? ''),
                String(event.data['fecha'] ?? ''),
              );
            }
            return;
          }
          const actualizado = await this.tickets.actualizarDesdePedido(
            tx,
            event as unknown as EventEnvelope<Partial<PedidoAbiertoData>>,
          );
          if (actualizado)
            this.logger.log(`Pedido ${String(event.data['codigo'])}: ticket actualizado`);
        });
        if (!procesado) this.logger.warn(`Evento ${event.id} duplicado: se ignora`);
      });
    });
  }
}
