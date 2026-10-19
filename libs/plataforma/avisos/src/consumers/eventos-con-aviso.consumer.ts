import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { runInEventSpan } from '@dyn/common';
import { EventBus, type EventEnvelope } from '@dyn/messaging';
import { PrismaService } from '../prisma/prisma.service';
import { AvisosService } from '../services/avisos.service';

/**
 * Eventos de otros contenedores que pueden generar avisos. Cada evento nuevo con regla se agrega aquí (el aviso en sí, a
 * quién y con qué texto, sale de las reglas de la base de datos).
 */
export const SUSCRIPCIONES: ReadonlyArray<{ source: string; patterns: string[] }> = [
  {
    source: 'operaciones',
    patterns: [
      'operaciones.pumping.ticket_creado',
      'operaciones.pumping.asignacion_realizada',
      'operaciones.pumping.salida_reportada',
      'operaciones.pumping.inspeccion_realizada',
      'operaciones.mantenimiento.reporte.recibido',
      'operaciones.mantenimiento.suborden.asignada',
      'operaciones.mantenimiento.suborden.derivada_a_pumping',
      'operaciones.mantenimiento.suborden.enviada_a_revision',
      'operaciones.mantenimiento.suborden.correccion_solicitada',
      'operaciones.mantenimiento.orden.aceptada',
      'operaciones.mantenimiento.orden.retornada',
      'operaciones.fcr.ticket_creado',
      'operaciones.fcr.asignacion_realizada',
      'operaciones.fcr.herramientas_solicitadas',
      'operaciones.fcr.aprobacion_solicitada',
      'operaciones.fcr.inspeccion_rechazada',
    ],
  },
  {
    source: 'flota',
    patterns: [
      'flota.gerenciamiento_viaje.por_autorizar_supervisor',
      'flota.gerenciamiento_viaje.por_autorizar_gerente',
      'flota.gerenciamiento_viaje.decidido',
      'flota.inspeccion_vehiculo.rechazada',
    ],
  },
  {
    source: 'qhse',
    patterns: [
      'qhse.epi.solicitudes_abiertas',
      'qhse.ptw.cerrado',
      'qhse.swa.activado',
      'qhse.stop.con_hallazgos',
      'qhse.inspeccion.rechazada',
    ],
  },
];

/** Recibe los eventos y los entrega al servicio de avisos; el inbox evita avisar dos veces por el mismo evento. */
@Injectable()
export class EventosConAvisoConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(EventosConAvisoConsumer.name);

  constructor(
    private readonly bus: EventBus,
    private readonly prisma: PrismaService,
    private readonly avisos: AvisosService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    for (const s of SUSCRIPCIONES) {
      await this.bus.subscribe({
        source: s.source,
        patterns: s.patterns,
        handler: (e) => this.consumir(e),
      });
    }
  }

  /** Público para poder probarlo sin RabbitMQ. */
  async consumir(event: EventEnvelope): Promise<void> {
    await runInEventSpan(`consume ${event.type}`, event.traceparent, async () => {
      await this.prisma.$transaction(
        async (tx) => {
          const procesado = await this.bus.handleOnce(tx, event, async () => {
            const r = await this.avisos.procesar(tx, event);
            this.logger.log(
              `${event.type}: ${r.avisos} aviso(s) en la campanita y ${r.correos} correo(s)`,
            );
          });
          if (!procesado) this.logger.warn(`Evento ${event.id} duplicado: se ignora`);
        },
        { timeout: 30_000 },
      );
    });
  }
}
