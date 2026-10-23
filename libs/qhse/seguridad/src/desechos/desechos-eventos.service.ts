import { Injectable } from '@nestjs/common';
import { currentTraceparent, type AuthUser } from '@dyn/common';
import { EventBus } from '@dyn/messaging';
import { aDia } from '../comun/fechas';
import type { Tx } from '../epi/epi-tipos';
import { codigoDesecho } from './desechos-consulta.service';

/** Publica por el outbox (en la misma transacción que el cambio) los hechos del ciclo de un desecho: ids estables para reportería y avisos. */
@Injectable()
export class DesechosEventosService {
  constructor(private readonly bus: EventBus) {}

  async publicar(
    tx: Tx,
    tipo: string,
    desechoId: string,
    actor: AuthUser,
    extra: Record<string, unknown> = {},
  ) {
    const d = await tx.desecho.findUniqueOrThrow({
      where: { id: desechoId },
      include: {
        estado: { select: { codigo: true } },
        contenedor: { select: { codigo: true } },
        items: { select: { cantidadGalones: true } },
        caracteristicas: { include: { caracteristica: { select: { codigo: true } } } },
        manifiesto: { select: { id: true, numero: true, fecha: true } },
      },
    });
    await this.bus.publish(
      tx,
      this.bus.create({
        type: tipo,
        subject: { type: 'desecho', id: desechoId },
        data: {
          desechoId,
          numero: d.numero,
          codigo: codigoDesecho(d.numero),
          estado: d.estado.codigo,
          clasificacion: d.clasificacion,
          cretib: d.caracteristicas.map((c) => c.caracteristica.codigo),
          contenedor: d.contenedor.codigo,
          pozoId: d.pozoId,
          totalGalones: d.items.reduce((t, i) => t + Number(i.cantidadGalones), 0),
          limiteAlmacenamientoHasta: aDia(d.limiteAlmacenamientoHasta),
          ...(d.manifiesto
            ? {
                manifiestoId: d.manifiesto.id,
                manifiestoNumero: d.manifiesto.numero,
                manifiestoFecha: aDia(d.manifiesto.fecha),
              }
            : {}),
          ...extra,
        },
        actor: { userId: actor.id, role: actor.roleCode },
        traceparent: currentTraceparent(),
      }),
    );
  }
}
