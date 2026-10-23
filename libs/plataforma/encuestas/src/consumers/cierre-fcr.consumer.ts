import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { runInEventSpan } from '@dyn/common';
import { EventBus, type EventEnvelope } from '@dyn/messaging';
import { PrismaService } from '../prisma/prisma.service';
import { EnviosService, type InvitacionPorEnviar } from '../services/envios.service';
import { InvitacionesService } from '../services/invitaciones.service';

export const EVENTO_CIERRE_FCR = 'operaciones.fcr.cerrado';
/** Código de la encuesta de satisfacción de FCR (la siembra `db:seed:encuestas`; la administración puede cambiar sus preguntas). */
export const ENCUESTA_FCR = 'fcr_satisfaccion';

/**
 * Al cerrar un ticket de FCR el Supervisor indica el correo del cliente: el evento lo trae y aquí se crea la invitación de la encuesta
 * de satisfacción y se le envía el enlace. La invitación se crea dentro de la transacción del inbox (un evento repetido no crea otra);
 * el correo sale después de confirmarla, y si falla queda anotado para reenviarlo desde la administración. Sin correo en el evento, o sin
 * encuesta publicada, se deja constancia en el registro y se sigue (no se reintenta indefinidamente).
 */
@Injectable()
export class CierreFcrConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(CierreFcrConsumer.name);

  constructor(
    private readonly bus: EventBus,
    private readonly prisma: PrismaService,
    private readonly invitaciones: InvitacionesService,
    private readonly envios: EnviosService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.bus.subscribe({
      source: 'operaciones',
      patterns: [EVENTO_CIERRE_FCR],
      // su propia cola: la auditoría ya lee los eventos de operaciones en este contenedor y no deben repartirse los mensajes
      group: 'encuestas',
      handler: (e) => this.consumir(e),
    });
  }

  /** Público para poder probarlo sin RabbitMQ. */
  async consumir(event: EventEnvelope): Promise<void> {
    if (event.type !== EVENTO_CIERRE_FCR) return;
    await runInEventSpan(`consume ${event.type}`, event.traceparent, async () => {
      let porEnviar: InvitacionPorEnviar | null = null;
      const d = event.data;
      await this.prisma.$transaction(async (tx) => {
        const nuevo = await this.bus.handleOnce(tx, event, async () => {
          const ticketId = String(d['ticketId'] ?? '');
          const correo = typeof d['correoCliente'] === 'string' ? d['correoCliente'].trim() : '';
          if (!ticketId || !correo) {
            this.logger.warn(
              `${event.type}: falta el ticket o el correo del cliente; no se envía la encuesta`,
            );
            return;
          }
          try {
            porEnviar = await this.invitaciones.crear(
              { encuestaCodigo: ENCUESTA_FCR, referenciaId: ticketId, correoDestino: correo },
              tx,
            );
          } catch (e) {
            // sin encuesta publicada o con un correo inválido no hay nada que reintentar: se deja constancia
            this.logger.warn(
              `${event.type}: no se creó la invitación del ticket ${ticketId}: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        });
        if (!nuevo) this.logger.warn(`Evento ${event.id} duplicado: se ignora`);
      });
      const inv = porEnviar as InvitacionPorEnviar | null;
      if (inv) {
        await this.envios.enviar(inv, {
          ticketNumero: typeof d['ticketNumero'] === 'number' ? d['ticketNumero'] : null,
          cliente: typeof d['cliente'] === 'string' ? d['cliente'] : null,
          pozo: typeof d['pozo'] === 'string' ? d['pozo'] : null,
        });
      }
    });
  }
}
