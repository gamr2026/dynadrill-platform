import { Injectable } from '@nestjs/common';
import { currentTraceparent, type AuthUser } from '@dyn/common';
import { EventBus } from '@dyn/messaging';
import { uuidv7 } from '@dyn/utils';
import type { Tx } from '../epi/epi-tipos';
import { codigoEmergencia } from './emergencias-consulta.service';

/**
 * Publica por el outbox (en la misma transacción que el cambio) los hechos del ciclo de una emergencia, con ids estables para reportería y
 * avisos, y deja la línea del cronómetro de las acciones del sistema.
 */
@Injectable()
export class EmergenciasEventosService {
  constructor(private readonly bus: EventBus) {}

  /** Línea del cronómetro (una por acción, con la hora del servidor). */
  async linea(tx: Tx, emergenciaId: string, texto: string, actor: AuthUser, automatica = true) {
    await tx.emergenciaLinea.create({
      data: { id: uuidv7(), emergenciaId, texto, automatica, actorId: actor.id },
    });
  }

  async publicar(
    tx: Tx,
    tipo: string,
    emergenciaId: string,
    actor: AuthUser,
    extra: Record<string, unknown> = {},
  ) {
    const e = await tx.emergencia.findUniqueOrThrow({
      where: { id: emergenciaId },
      include: { tipo: { select: { codigo: true, nombre: true } } },
    });
    const [ticket, activador] = await Promise.all([
      e.ticketId
        ? tx.ticketRef.findUnique({
            where: { ticketId: e.ticketId },
            select: {
              ticketNumero: true,
              pedidoId: true,
              pedidoCodigo: true,
              cliente: true,
              campo: true,
              pozo: true,
            },
          })
        : null,
      tx.idUsuario.findUnique({ where: { id: e.activadoPor }, select: { nombre: true } }),
    ]);
    await this.bus.publish(
      tx,
      this.bus.create({
        type: tipo,
        subject: { type: 'emergencia', id: emergenciaId },
        data: {
          emergenciaId,
          numero: e.numero,
          codigo: codigoEmergencia(e.numero),
          estado: e.estado,
          tipoEmergencia: e.tipo.codigo,
          tipoNombre: e.tipo.nombre,
          swaId: e.swaId,
          derrameId: e.derrameId,
          ticketId: e.ticketId,
          ticketNumero: ticket?.ticketNumero ?? null,
          pedidoId: ticket?.pedidoId ?? null,
          pedidoCodigo: ticket?.pedidoCodigo ?? null,
          cliente: ticket?.cliente ?? null,
          campo: ticket?.campo ?? null,
          pozo: ticket?.pozo ?? null,
          // texto para el aviso (no cambia: es lo que se escribió al activar la emergencia)
          descripcion: e.descripcion,
          ubicacion: e.ubicacion,
          activadoPor: activador?.nombre ?? null,
          ...extra,
        },
        actor: { userId: actor.id, role: actor.roleCode },
        traceparent: currentTraceparent(),
      }),
    );
  }
}
