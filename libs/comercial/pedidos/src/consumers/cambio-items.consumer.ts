import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { currentTraceparent, runInEventSpan, type AuthUser } from '@dyn/common';
import { EventBus, type EventEnvelope } from '@dyn/messaging';
import type { ItemPedidoDto } from '../dto/pedidos.dto';
import { PrismaService } from '../prisma/prisma.service';
import { CambioItemsService } from '../services/cambio-items.service';

export const EVENTO_CAMBIO_APROBADO = 'operaciones.pumping.cambio_items_aprobado';
export const EVENTO_CAMBIO_APROBADO_FCR = 'operaciones.fcr.cambio_items_aprobado';
const EVENTOS = [EVENTO_CAMBIO_APROBADO, EVENTO_CAMBIO_APROBADO_FCR];
export const EVENTO_CAMBIO_RESULTADO = 'comercial.cambio_items.resultado';

/**
 * El Supervisor de Pumping o de FCR aprobó un cambio de ítems del pedido: Comercial lo aplica y devuelve el resultado
 * (`comercial.cambio_items.resultado`: aplicado o por qué no pudo, p. ej. el pedido ya salió al cliente para firmas) para que el
 * ticket lo muestre. Idempotente por el inbox; un error que no sea de negocio revierte el inbox y el mensaje se reintenta.
 */
@Injectable()
export class CambioItemsConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(CambioItemsConsumer.name);

  constructor(
    private readonly bus: EventBus,
    private readonly prisma: PrismaService,
    private readonly cambios: CambioItemsService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.bus.subscribe({
      source: 'operaciones',
      patterns: EVENTOS,
      group: 'cambio-items',
      handler: (e) => this.consumir(e),
    });
  }

  /** Público para poder probarlo sin RabbitMQ. */
  async consumir(event: EventEnvelope): Promise<void> {
    if (!EVENTOS.includes(event.type)) return;
    await runInEventSpan(`consume ${event.type}`, event.traceparent, async () => {
      await this.prisma.$transaction(async (tx) => {
        const nuevo = await this.bus.handleOnce(tx, event, async () => {
          const d = event.data;
          const solicitudId = String(d['solicitudId'] ?? '');
          const pedidoId = String(d['pedidoId'] ?? '');
          const userId = event.actor?.userId;
          if (!solicitudId || !pedidoId || !userId) {
            this.logger.warn(
              `${event.type}: falta la solicitud, el pedido o quién aprobó; se ignora`,
            );
            return;
          }
          const actor = {
            id: userId,
            email: '',
            name: '',
            roleId: '',
            roleCode: event.actor?.role ?? 'supervisor',
            impersonated: false,
            permissions: [],
            mustChangePassword: false,
          } as unknown as AuthUser;
          let motivo: string | null = null;
          try {
            await this.cambios.aplicar(pedidoId, (d['items'] ?? []) as ItemPedidoDto[], actor);
          } catch (e) {
            if (
              e instanceof ConflictException ||
              e instanceof NotFoundException ||
              e instanceof BadRequestException
            ) {
              motivo = e.message;
            } else {
              throw e;
            }
          }
          await this.bus.publish(
            tx,
            this.bus.create({
              type: EVENTO_CAMBIO_RESULTADO,
              subject: { type: 'pedido', id: pedidoId },
              data: { solicitudId, pedidoId, aplicado: motivo === null, motivo },
              actor: { userId, role: actor.roleCode },
              traceparent: currentTraceparent(),
            }),
          );
          this.logger.log(
            `Pedido ${pedidoId}: cambio de ítems ${motivo === null ? 'aplicado' : `no aplicado (${motivo})`}`,
          );
        });
        if (!nuevo) this.logger.warn(`Evento ${event.id} duplicado: se ignora`);
      });
    });
  }
}
