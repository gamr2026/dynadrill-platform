import { Injectable } from '@nestjs/common';
import { currentTraceparent, type AuthUser } from '@dyn/common';
import { EventBus } from '@dyn/messaging';
import type { Tx } from '../epi/epi-tipos';
import {
  DerramesConsultaService,
  codigoDerrame,
  escalaAEmergencia,
  requiereNotificacionMae,
} from './derrames-consulta.service';

/** Publica por el outbox (en la misma transacción que el cambio) los hechos del ciclo de un derrame, con ids estables para reportería y avisos. */
@Injectable()
export class DerramesEventosService {
  constructor(
    private readonly bus: EventBus,
    private readonly consulta: DerramesConsultaService,
  ) {}

  async publicar(
    tx: Tx,
    tipo: string,
    derrameId: string,
    actor: AuthUser,
    extra: Record<string, unknown> = {},
  ) {
    const d = await tx.derrame.findUniqueOrThrow({
      where: { id: derrameId },
      include: { ubicacion: true, banda: true },
    });
    const bandas = await this.consulta.bandasActivas(tx);
    const reglas = this.consulta.reglas(d, bandas);
    const [ticket, activador] = await Promise.all([
      d.ticketId
        ? tx.ticketRef.findUnique({
            where: { ticketId: d.ticketId },
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
      tx.idUsuario.findUnique({ where: { id: d.activadoPor }, select: { nombre: true } }),
    ]);
    await this.bus.publish(
      tx,
      this.bus.create({
        type: tipo,
        subject: { type: 'derrame', id: derrameId },
        data: {
          derrameId,
          numero: d.numero,
          codigo: codigoDerrame(d.numero),
          estado: d.estado,
          ubicacion: d.ubicacion.codigo,
          ubicacionNombre: d.ubicacion.nombre,
          banda: d.banda.codigo,
          bandaNombre: d.banda.nombre,
          volumenRealBarriles:
            d.volumenRealBarriles === null ? null : Number(d.volumenRealBarriles),
          requiereNotificacionMae: requiereNotificacionMae(reglas),
          escalaAEmergencia: escalaAEmergencia(reglas),
          ticketId: d.ticketId,
          ticketNumero: ticket?.ticketNumero ?? null,
          pedidoId: ticket?.pedidoId ?? null,
          pedidoCodigo: ticket?.pedidoCodigo ?? null,
          cliente: ticket?.cliente ?? null,
          campo: ticket?.campo ?? null,
          pozo: ticket?.pozo ?? null,
          // texto para el aviso (no cambia: es lo que se escribió al activar la alerta)
          descripcion: d.descripcion,
          ubicacionFisica: d.ubicacionFisica,
          activadoPor: activador?.nombre ?? null,
          ...extra,
        },
        actor: { userId: actor.id, role: actor.roleCode },
        traceparent: currentTraceparent(),
      }),
    );
  }
}
