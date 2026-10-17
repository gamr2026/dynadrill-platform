import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { runInEventSpan, type AuthUser } from '@dyn/common';
import { EventBus, type EventEnvelope } from '@dyn/messaging';
import { PrismaService } from '../prisma/prisma.service';
import { PrefacturasService } from '../services/prefacturas.service';

/** Eventos con los que Operaciones da por cerrado el servicio (contrato 4.10). */
export const EVENTOS_TICKET_CERRADO = [
  'operaciones.pumping.cerrado',
  'operaciones.fcr.cerrado',
] as const;

/**
 * Al cerrarse el ticket (Pumping aprobado, FCR cerrado) genera la prefactura del pedido si la documentación de respaldo está
 * completa y todavía no existe una vigente. Si no se puede (documentación incompleta, ya existe, el pedido está en otra etapa) lo
 * omite sin fallar: el cierre del ticket nunca depende de Facturación. Idempotente por el inbox.
 */
@Injectable()
export class TicketCerradoConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(TicketCerradoConsumer.name);

  constructor(
    private readonly bus: EventBus,
    private readonly prisma: PrismaService,
    private readonly prefacturas: PrefacturasService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.bus.subscribe({
      source: 'operaciones',
      patterns: [...EVENTOS_TICKET_CERRADO],
      handler: (e) => this.consumir(e),
    });
  }

  /** Público para poder probarlo sin RabbitMQ. */
  async consumir(event: EventEnvelope): Promise<void> {
    if (!(EVENTOS_TICKET_CERRADO as readonly string[]).includes(event.type)) return;
    await runInEventSpan(`consume ${event.type}`, event.traceparent, async () => {
      const nuevo = await this.prisma.$transaction((tx) =>
        this.bus.handleOnce(tx, event, async () => undefined),
      );
      if (!nuevo) {
        this.logger.warn(`Evento ${event.id} duplicado: se ignora`);
        return;
      }
      const pedidoId = String(event.data['pedidoId'] ?? '');
      const userId = event.actor?.userId;
      if (!pedidoId || !userId) {
        this.logger.warn(`${event.type}: falta pedidoId o quién cerró; se ignora`);
        return;
      }
      // quien cerró el ticket queda como quien generó la prefactura; sin permisos propios (el servicio no los revisa)
      const actor = {
        id: userId,
        email: '',
        name: '',
        roleId: '',
        roleCode: event.actor?.role ?? 'superadmin',
        impersonated: false,
        permissions: [],
        mustChangePassword: false,
      } as unknown as AuthUser;
      try {
        await this.prefacturas.generar(pedidoId, { actor, token: '' });
        this.logger.log(`Pedido ${pedidoId}: prefactura generada al cerrar el ticket`);
      } catch (e) {
        this.logger.log(
          `Pedido ${pedidoId}: no se generó la prefactura al cerrar el ticket (${(e as Error).message})`,
        );
      }
    });
  }
}
