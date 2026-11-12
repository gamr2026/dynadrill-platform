import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { runInEventSpan, type AuthUser } from '@dyn/common';
import { EventBus, type EventEnvelope } from '@dyn/messaging';
import { FasePtw } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import { PtwService } from '../ptw/ptw.service';

/** Evento de comercial (otro contenedor) cuando se anula un pedido: `{ pedidoId, codigo, motivo }`. */
export const EVENTO_PEDIDO_ANULADO = 'comercial.pedido.anulado';

const esUuid = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

/**
 * Se entera de que comercial anuló un pedido y lo refleja en la réplica de tickets (`ticket_ref.anulado_at`). Desde ese momento el ticket no
 * recibe documentos, PTW, SWA, EPI ni inspecciones nuevos, la tarea programada no le abre PTW y no genera avisos ni tareas.
 *  - Los PTW del pedido que siguen abiertos o sin aprobar se anulan por el camino normal de anulación de PTW (con su historial y su evento);
 *    los ya aprobados y todo lo demás ya creado queda tal cual, por trazabilidad.
 *  - Es idempotente: el inbox descarta el evento repetido y un ticket ya anulado conserva su primera fecha y motivo.
 *  - Un evento al que le falta el pedido se ignora sin error.
 */
@Injectable()
export class PedidosEventosConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(PedidosEventosConsumer.name);

  constructor(
    private readonly bus: EventBus,
    private readonly prisma: PrismaService,
    private readonly ptw: PtwService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.bus.subscribe({
      source: 'comercial',
      // su propia cola: otros módulos de este contenedor ya leen eventos de comercial y no deben repartirse los mensajes
      group: 'qhse',
      patterns: [EVENTO_PEDIDO_ANULADO],
      handler: (e) => this.consumir(e),
    });
  }

  /** Público para poder probarlo sin RabbitMQ. */
  async consumir(event: EventEnvelope): Promise<void> {
    if (event.type !== EVENTO_PEDIDO_ANULADO) return;
    await runInEventSpan(`consume ${event.type}`, event.traceparent, async () => {
      await this.prisma.$transaction(async (tx) => {
        const procesado = await this.bus.handleOnce(tx, event, async () => {
          const pedidoId = event.data['pedidoId'];
          if (!esUuid(pedidoId)) {
            this.logger.warn(`${event.type}: falta pedidoId; se ignora`);
            return;
          }
          const motivo =
            typeof event.data['motivo'] === 'string' ? event.data['motivo'].trim() || null : null;
          const cuando = new Date(event.occurredAt);
          const anuladoAt = Number.isNaN(cuando.getTime()) ? new Date() : cuando;

          const tickets = await tx.ticketRef.updateMany({
            where: { pedidoId, anuladoAt: null },
            data: { anuladoAt, anuladoMotivo: motivo },
          });
          if (tickets.count === 0)
            this.logger.warn(
              `${event.type}: QHSE no tiene tickets vigentes del pedido ${pedidoId}; no hay nada que marcar`,
            );

          // los PTW que siguen abiertos o sin aprobar se anulan por el camino normal; los aprobados no se tocan
          const abiertos = await tx.ptw.findMany({
            where: { pedidoId, anuladoAt: null, fase: { not: FasePtw.aprobado } },
            select: { id: true, createdBy: true },
          });
          const quien = event.actor?.userId;
          const actorEvento =
            esUuid(quien) && (await tx.idUsuario.count({ where: { id: quien } })) ? quien : null;
          const razon = `Pedido anulado${motivo ? `: ${motivo}` : ''}`;
          for (const p of abiertos)
            await this.ptw.anularEn(tx, p.id, razon, {
              // a nombre de quien anuló el pedido; si esa cuenta no existe en identidad, la anulación queda a nombre de quien abrió el PTW
              id: actorEvento ?? p.createdBy,
              roleCode: (event.actor?.role ?? 'sistema') as AuthUser['roleCode'],
            });
          this.logger.log(
            `Pedido ${String(event.data['codigo'] ?? pedidoId)} anulado: ${tickets.count} ticket(s) marcado(s), ${abiertos.length} PTW anulado(s)`,
          );
        });
        if (!procesado) this.logger.warn(`Evento ${event.id} duplicado: se ignora`);
      });
    });
  }
}
