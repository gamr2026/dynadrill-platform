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
import { PrismaService } from '../prisma/prisma.service';
import { PedidosService } from '../services/pedidos.service';

export const EVENTO_DURACION_CAMBIADA = 'operaciones.pumping.duracion_servicio_cambiada';
export const EVENTO_DURACION_RECHAZADA = 'comercial.duracion_servicio.rechazada';

/**
 * El Jefe de Base de Pumping acortó o amplió la duración de un servicio: la fecha de fin es del pedido, así que Comercial la aplica y publica
 * `comercial.pedido.actualizado` (el ticket y los demás módulos toman la fecha de ahí). Si no puede (el pedido ya salió al cliente para firmas, no
 * existe, etc.) publica `comercial.duracion_servicio.rechazada` para que Pumping revierta el cambio y no queden distintos. Idempotente por el inbox;
 * un error que no sea de negocio revierte el inbox y el mensaje se reintenta.
 */
@Injectable()
export class DuracionServicioConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(DuracionServicioConsumer.name);

  constructor(
    private readonly bus: EventBus,
    private readonly prisma: PrismaService,
    private readonly pedidos: PedidosService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.bus.subscribe({
      source: 'operaciones',
      patterns: [EVENTO_DURACION_CAMBIADA],
      group: 'duracion-servicio',
      handler: (e) => this.consumir(e),
    });
  }

  /** Público para poder probarlo sin RabbitMQ. */
  async consumir(event: EventEnvelope): Promise<void> {
    if (event.type !== EVENTO_DURACION_CAMBIADA) return;
    await runInEventSpan(`consume ${event.type}`, event.traceparent, async () => {
      await this.prisma.$transaction(async (tx) => {
        const nuevo = await this.bus.handleOnce(tx, event, async () => {
          const d = event.data;
          const pedidoId = String(d['pedidoId'] ?? '');
          const fechaFin = String(d['fechaFinNueva'] ?? '');
          const userId = event.actor?.userId;
          if (!pedidoId || !/^\d{4}-\d{2}-\d{2}$/.test(fechaFin) || !userId) {
            this.logger.warn(
              `${event.type}: faltan el pedido, la fecha o quién decidió; se ignora`,
            );
            return;
          }
          const actor = {
            id: userId,
            email: '',
            name: '',
            roleId: '',
            roleCode: event.actor?.role ?? 'jefe_base',
            impersonated: false,
            permissions: [],
            mustChangePassword: false,
          } as unknown as AuthUser;
          let motivo: string | null = null;
          try {
            const accion = d['accion'] === 'ampliar' ? 'ampliar' : 'acortar';
            await this.pedidos.aplicarFechaFinDeOperaciones(
              pedidoId,
              fechaFin,
              { actor, token: '' },
              {
                accion,
                motivo: String(d['motivo'] ?? 'Sin motivo indicado'),
                ticketNumero: typeof d['ticketNumero'] === 'number' ? d['ticketNumero'] : null,
              },
            );
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
          if (motivo !== null) {
            await this.bus.publish(
              tx,
              this.bus.create({
                type: EVENTO_DURACION_RECHAZADA,
                subject: { type: 'pedido', id: pedidoId },
                data: {
                  pedidoId,
                  ticketId: d['ticketId'] ?? null,
                  fechaFinAnterior: d['fechaFinAnterior'] ?? null,
                  fechaFinNueva: fechaFin,
                  motivo,
                },
                actor: { userId, role: actor.roleCode },
                traceparent: currentTraceparent(),
              }),
            );
          }
          this.logger.log(
            `Pedido ${pedidoId}: fecha de fin ${motivo === null ? `cambiada al ${fechaFin}` : `no cambiada (${motivo})`}`,
          );
        });
        if (!nuevo) this.logger.warn(`Evento ${event.id} duplicado: se ignora`);
      });
    });
  }
}
