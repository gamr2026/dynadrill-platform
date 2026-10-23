import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { runInEventSpan } from '@dyn/common';
import { EventBus, type EventEnvelope } from '@dyn/messaging';
import { PrismaService } from '../prisma/prisma.service';
import { EventoNoAuditable, ProyectorService } from '../services/proyector.service';

/** Contenedores productores. `plataforma` incluye sus propios eventos; `worker` ya está para cuando publique. */
export const ORIGENES_AUDITADOS = [
  'comercial',
  'operaciones',
  'flota',
  'qhse',
  'plataforma',
  'worker',
] as const;

/** Grupo propio: la plataforma ya tiene otros consumidores de estos orígenes (avisos) y sin él se repartirían los mensajes. */
export const GRUPO_AUDITORIA = 'auditoria';

/** Recibe TODOS los eventos de todos los contenedores y los proyecta en el registro de auditoría, una sola vez por evento. */
@Injectable()
export class AuditoriaConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(AuditoriaConsumer.name);

  constructor(
    private readonly bus: EventBus,
    private readonly prisma: PrismaService,
    private readonly proyector: ProyectorService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    for (const source of ORIGENES_AUDITADOS) {
      await this.bus.subscribe({
        source,
        group: GRUPO_AUDITORIA,
        patterns: ['#'],
        handler: (e) => this.consumir(e),
      });
    }
  }

  /** Público para poder probarlo sin RabbitMQ. */
  async consumir(event: EventEnvelope): Promise<void> {
    await runInEventSpan(`auditar ${event.type}`, event.traceparent, async () => {
      try {
        await this.prisma.$transaction(
          async (tx) => {
            const nuevo = await this.bus.handleOnce(tx, event, () =>
              this.proyector.registrar(tx, event),
            );
            if (!nuevo) this.logger.warn(`Evento ${event.id} duplicado: se ignora`);
          },
          { timeout: 30_000 },
        );
      } catch (e) {
        // un evento mal formado no mejora al reintentar: se registra y se omite; lo demás se relanza para reintentar
        if (e instanceof EventoNoAuditable) {
          this.logger.error(e.message);
          return;
        }
        throw e;
      }
    });
  }
}
