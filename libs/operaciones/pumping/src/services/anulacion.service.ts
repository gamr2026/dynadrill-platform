import { Injectable } from '@nestjs/common';
import { currentTraceparent } from '@dyn/common';
import { MovimientosService } from '@dyn/inventario';
import { EventBus, type EventEnvelope } from '@dyn/messaging';
import { uuidv7 } from '@dyn/utils';
import type { Prisma } from '../generated/client';
import { PASO_ANULADO } from '../guards/ticket-no-anulado.guard';
import { etiquetaDeUnidad, UNIDAD_CON_PLACA } from './unidad-etiqueta';
import { nombreDe } from './tickets.service';

/** Químico que el ticket tenía a su cargo al anularse y lo que se hizo con él (va en el evento para Inventario). */
interface QuimicoAnulado {
  articuloId: string;
  codigo: string;
  nombre: string;
  unidad: string;
  asignada: number;
  usada: number;
  devuelta: number;
  /** Lo que seguía a cargo del ticket al anularse. */
  pendiente: number;
  /** Lo que la anulación devolvió a bodega, sumado de todas las bodegas. */
  devueltaPorAnulacion: number;
  /** Lo que no se pudo devolver: queda a cargo del ticket como devolución pendiente que Bodega resuelve. */
  devolucionPendiente: number;
  /** Lo anterior, por bodega de la que salió el químico. */
  bodegas: Array<{
    bodegaId: string;
    bodega: string | null;
    devueltaPorAnulacion: number;
    devolucionPendiente: number;
  }>;
}

/**
 * Anula el ticket del pedido que Comercial anuló (`comercial.pedido.anulado`): lo pasa al paso terminal `anulado` desde cualquier paso que no
 * sea terminal, anota la historia con el motivo y quién anuló, devuelve a bodega los químicos que seguían a cargo del ticket y publica
 * `operaciones.pumping.ticket_anulado`. Quien se había asignado y las unidades dejan de contar como ocupados porque la disponibilidad solo
 * mira tickets de pasos no terminales; las filas de asignación se conservan como historia.
 */
@Injectable()
export class AnulacionService {
  constructor(
    private readonly bus: EventBus,
    private readonly inventario: MovimientosService,
  ) {}

  /**
   * Dentro de la transacción del consumidor (que ya registró el evento en el inbox). `false` si no había nada que anular: el pedido no tiene
   * ticket de Pumping, o el ticket ya está cerrado o anulado.
   */
  async anularDesdePedido(tx: Prisma.TransactionClient, event: EventEnvelope): Promise<boolean> {
    const t = await tx.ticket.findUnique({
      where: { pedidoId: event.subject.id },
      include: {
        paso: true,
        cliente: true,
        pozo: true,
        personas: { include: { usuario: true } },
        unidades: { include: { unidad: UNIDAD_CON_PLACA } },
      },
    });
    if (!t || t.paso.terminal) return false;

    const actorId = await this.cuentaExistente(tx, event.actor?.userId);
    const motivoEvento = event.data['motivo'];
    const motivo =
      (typeof motivoEvento === 'string' ? motivoEvento.trim() : '') ||
      'Pedido anulado en Comercial';

    // lo que el ticket tenía a cargo en Inventario vuelve a bodega antes de tocar el ticket: si esto falla, el evento se reintenta con el ticket
    // intacto; y si falla lo que sigue, el reintento solo devuelve lo que aún está pendiente (nunca dos veces)
    const quimicos = await this.devolverQuimicos(t.id, actorId);

    const r = await tx.ticket.updateMany({
      where: { id: t.id, pasoCodigo: t.pasoCodigo },
      data: { pasoCodigo: PASO_ANULADO, version: { increment: 1 } },
    });
    if (r.count === 0)
      throw new Error('El ticket cambió de paso mientras se anulaba; se reintenta');
    await tx.ticketHistorial.create({
      data: {
        id: uuidv7(),
        ticketId: t.id,
        pasoAnterior: t.pasoCodigo,
        pasoNuevo: PASO_ANULADO,
        motivo,
        actorId,
        actorRol: event.actor?.role ?? null,
        origen: 'sistema',
      },
    });

    await this.bus.publish(
      tx,
      this.bus.create({
        type: 'operaciones.pumping.ticket_anulado',
        subject: { type: 'pumping_ticket', id: t.id },
        data: {
          ticketId: t.id,
          ticketNumero: t.ticketNumero,
          pedidoId: t.pedidoId,
          pedidoCodigo: t.pedidoCodigo,
          cliente: nombreDe(t.cliente),
          pozo: t.pozo?.nombreCompleto ?? null,
          pasoAnterior: t.pasoCodigo,
          motivo,
          anuladoPor: event.actor?.userId ?? null,
          // a quienes estaban asignados se les avisa (misma forma que en `asignacion_realizada`) y dejan de estar ocupados
          asignados: t.personas.map((p) => ({ usuarioId: p.usuarioId, rolCodigo: p.rol })),
          personas: t.personas.map((p) => ({
            usuarioId: p.usuarioId,
            nombre: p.usuario.nombre,
            rolCodigo: p.rol,
            unidadId: p.unidadId,
          })),
          unidadesIds: t.unidades.map((u) => u.unidadId),
          unidades: t.unidades.map((u) => etiquetaDeUnidad(u.unidad)).join(', '),
          // lo despachado desde Inventario y lo que la anulación devolvió; `devolucionPendiente` avisa si algo quedó a cargo del ticket
          quimicos,
          devolucionPendiente: quimicos.some((q) => q.devolucionPendiente > 0),
        },
        ...(event.actor ? { actor: event.actor } : {}),
        causationId: event.id,
        correlationId: event.correlationId,
        traceparent: currentTraceparent(),
      }),
    );
    return true;
  }

  /** El id del actor solo si es una cuenta real (la historia lo guarda con FK a identidad.usuario). */
  private async cuentaExistente(
    tx: Prisma.TransactionClient,
    userId: string | undefined,
  ): Promise<string | null> {
    if (!userId) return null;
    const u = await tx.idUsuario.findUnique({ where: { id: userId }, select: { id: true } });
    return u?.id ?? null;
  }

  /**
   * Devuelve a bodega lo que sigue a cargo del ticket (asignado menos usado menos devuelto) con la devolución del sistema de Inventario: no
   * depende del rol de quien anuló (`anuladoPor` es solo la referencia, si se sabe) y reparte entre las bodegas de las que salió cada químico.
   * Lo que no se pueda devolver queda como devolución pendiente a la vista de Bodega; la anulación del ticket no espera a eso. Si Inventario
   * mismo falla, la excepción sube y el evento se reintenta con el ticket intacto. El evento reporta lo devuelto y lo pendiente por químico y bodega.
   */
  private async devolverQuimicos(
    ticketId: string,
    anuladoPor: string | null,
  ): Promise<QuimicoAnulado[]> {
    const hechas = await this.inventario.devolverPorAnulacion(ticketId, anuladoPor);
    const balance = await this.inventario.quimicosDeTicket(ticketId);
    // el balance ya incluye lo que devolvió la anulación (en esta pasada o en una anterior, si el evento se reintenta): se le quita para
    // reportar lo que el ticket tenía a su cargo al anularse
    return balance.map((b) => {
      const bodegas = hechas
        .filter((h) => h.articuloId === b.articuloId)
        .map((h) => ({
          bodegaId: h.bodegaId,
          bodega: b.bodegas.find((x) => x.bodegaId === h.bodegaId)?.bodega ?? null,
          devueltaPorAnulacion: h.devuelta,
          devolucionPendiente: h.pendiente,
        }));
      const devuelta = bodegas.reduce((t, x) => t + x.devueltaPorAnulacion, 0);
      return {
        articuloId: b.articuloId,
        codigo: b.codigo,
        nombre: b.nombre,
        unidad: b.unidad,
        asignada: b.asignada,
        usada: b.usada,
        devuelta: b.devuelta - devuelta,
        pendiente: b.pendiente + devuelta,
        devueltaPorAnulacion: devuelta,
        devolucionPendiente: bodegas.reduce((t, x) => t + x.devolucionPendiente, 0),
        bodegas,
      };
    });
  }
}
