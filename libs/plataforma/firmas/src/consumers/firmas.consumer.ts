import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { runInEventSpan } from '@dyn/common';
import { EventBus, type EventEnvelope } from '@dyn/messaging';
import { PrismaService } from '../prisma/prisma.service';
import { RegistradorService } from '../services/registrador.service';

/** Contenedores que publican firmas. Un contenedor nuevo que firme documentos se agrega aquí. */
export const ORIGENES_DE_FIRMAS = [
  'comercial',
  'operaciones',
  'flota',
  'qhse',
  'plataforma',
] as const;

/** Grupo propio: la plataforma ya tiene otros consumidores de estos orígenes y sin él se repartirían los mensajes. */
export const GRUPO_FIRMAS = 'firmas';

/** Cualquier tipo de evento que termine en `.firmado` (`qhse.ptw.firmado`, `operaciones.fcr.inspeccion.firmado`...). */
export const PATRON_FIRMADO = '#.firmado';

/** Recibe los eventos `*.firmado` de los módulos y los registra como evidencia, una sola vez por evento. */
@Injectable()
export class FirmasConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(FirmasConsumer.name);

  constructor(
    private readonly bus: EventBus,
    private readonly prisma: PrismaService,
    private readonly registrador: RegistradorService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    for (const source of ORIGENES_DE_FIRMAS) {
      await this.bus.subscribe({
        source,
        group: GRUPO_FIRMAS,
        patterns: [PATRON_FIRMADO],
        handler: (e) => this.consumir(e),
      });
    }
  }

  /**
   * Público para poder probarlo sin RabbitMQ. Todo error se relanza: el transporte reintenta y, si no mejora, deja el mensaje en
   * la cola de fallidos (una firma que no se pudo registrar debe revisarse, no perderse).
   */
  async consumir(event: EventEnvelope): Promise<void> {
    await runInEventSpan(`firmar ${event.type}`, event.traceparent, async () => {
      await this.prisma.$transaction(
        async (tx) => {
          const nuevo = await this.bus.handleOnce(tx, event, () =>
            this.registrador.registrar(tx, event),
          );
          if (!nuevo) this.logger.warn(`Evento ${event.id} duplicado: se ignora`);
        },
        { timeout: 30_000 },
      );
    });
  }
}
