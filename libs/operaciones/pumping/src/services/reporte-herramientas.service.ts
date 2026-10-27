import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { currentTraceparent, type AuthUser } from '@dyn/common';
import { EventBus } from '@dyn/messaging';
import { uuidv7 } from '@dyn/utils';
import type { EstadoItemReporte, Prisma, TipoLineaItem } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import { puedeActuar, puedeActuarEn } from './tickets.service';

const PASO = 'ejecucion_operativa';
const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const deDia = (f: string) => new Date(`${f}T00:00:00.000Z`);
const aDia = (d: Date) => d.toISOString().slice(0, 10);
const redondear = (n: number) => Math.round(n * 1000) / 1000;
const TIPOS_LINEA: readonly string[] = ['servicio', 'material', 'herramienta', 'movilizacion'];

/** Una fila es «por día» cuando su unidad se mide en días: se reporta con marcas por día (cada una vale 1). */
export const esUnidadPorDia = (unidad: { periodo: string | null } | null | undefined): boolean =>
  unidad?.periodo === 'dia';

/** Una línea cotizada del pedido, tal como la publica `comercial` en sus eventos. */
export interface LineaPedido {
  codigo: string;
  descripcion: string;
  /** Unidad del catálogo compartido (`catalogos.unidad_medida`), la de la lista de precios. */
  unidadMedidaId: string;
  cantidad: number;
  tipoLinea: string;
  listaPreciosItemId?: string | null;
}

const LINEA_CON_DIAS = {
  dias: { orderBy: { fecha: 'asc' } },
  unidadMedida: { select: { nombre: true, periodo: true } },
} satisfies Prisma.TicketLineaInclude;

/**
 * Reporte de Herramientas de un ticket de Pumping (como el de FCR, pero sin selección de herramientas ni inspecciones): las filas son las
 * líneas cotizadas del pedido (menos la movilización) y el operador reparte la cantidad de cada una en los días del servicio, con una marca que
 * vale 1 en las líneas por día y la cantidad aplicada ese día en las demás. Lo reportado de una línea no puede pasar de lo cotizado (lo vigila
 * también la base). Al completarlo se publica `operaciones.pumping.reporte_herramientas_completado` con la misma forma que el de FCR y Comercial
 * lo recibe como documento operativo.
 */
@Injectable()
export class ReporteHerramientasService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: EventBus,
  ) {}

  /** `actorId`: quien consulta; si el reporte aún no se precargó y el ticket está en la ejecución, se precarga una sola vez. */
  async obtener(ticketId: string, actorId?: string) {
    if (actorId) await this.precargarSiCorresponde(ticketId, actorId);
    const t = await this.prisma.ticket.findUnique({
      where: { id: ticketId },
      select: {
        fechaInicioServicio: true,
        fechaFinServicio: true,
        reporteHerramientasCompletadoAt: true,
      },
    });
    if (!t) throw new NotFoundException('El ticket no existe');
    const lineas = await this.prisma.ticketLinea.findMany({
      where: { ticketId, tipoLinea: { not: 'movilizacion' } },
      include: LINEA_CON_DIAS,
      orderBy: { orden: 'asc' },
    });
    return {
      completadoAt: t.reporteHerramientasCompletadoAt,
      fechaInicio: t.fechaInicioServicio ? aDia(t.fechaInicioServicio) : null,
      fechaFin: t.fechaFinServicio ? aDia(t.fechaFinServicio) : null,
      lineas: lineas.map((l) => ({
        id: l.id,
        orden: l.orden,
        listaPreciosItemId: l.listaPreciosItemId,
        codigo: l.codigo,
        descripcion: l.descripcion,
        unidad: l.unidadMedida.nombre,
        unidadMedidaId: l.unidadMedidaId,
        tipoLinea: l.tipoLinea,
        porDia: esUnidadPorDia(l.unidadMedida),
        /** Lo cotizado por Ventas: el tope de lo que se puede reportar. */
        cotizado: Number(l.cantidad),
        /** Lo reportado hasta ahora: la suma de sus días. */
        cantidad: this.reportado(l),
        dias: l.dias.map((d) => ({
          fecha: aDia(d.fecha),
          estado: d.estado,
          cantidad: Number(d.cantidad),
        })),
      })),
    };
  }

  /**
   * Pone (o quita con `estado = null`) la celda de un día. En una línea por día la marca vale 1; en las demás hay que indicar la cantidad
   * aplicada ese día. El día va dentro de las fechas del servicio. Cambiar el reporte ya completado lo reabre.
   */
  async marcarDia(
    ticketId: string,
    lineaId: string,
    fecha: string,
    estado: EstadoItemReporte | null,
    cantidad: number | undefined,
    actor: AuthUser,
  ) {
    this.exigirFecha(fecha);
    await this.prisma.$transaction(async (tx) => {
      const t = await this.exigirEquipo(tx, ticketId, actor);
      if (
        (t.fechaInicioServicio && fecha < aDia(t.fechaInicioServicio)) ||
        (t.fechaFinServicio && fecha > aDia(t.fechaFinServicio))
      ) {
        throw new BadRequestException({
          message: 'El día está fuera de las fechas del servicio del pedido',
          code: 'FUERA_DEL_SERVICIO',
        });
      }
      const l = await tx.ticketLinea.findFirst({
        where: { id: lineaId, ticketId },
        include: { unidadMedida: { select: { periodo: true } }, dias: true },
      });
      if (!l) throw new NotFoundException('La línea no existe en el reporte de este ticket');
      if (l.tipoLinea === 'movilizacion') {
        throw new BadRequestException('La movilización no va en el Reporte de Herramientas');
      }
      const previo = l.dias.find((d) => aDia(d.fecha) === fecha);
      if (estado === null) {
        if (previo) await tx.reporteItemDia.delete({ where: { id: previo.id } });
      } else {
        let valor = 1;
        if (!esUnidadPorDia(l.unidadMedida)) {
          if (!(typeof cantidad === 'number' && cantidad > 0)) {
            throw new BadRequestException(
              'Escriba la cantidad aplicada ese día (mayor que cero)',
            );
          }
          valor = cantidad;
        }
        const otros = l.dias.filter((d) => d.id !== previo?.id);
        const suma = redondear(otros.reduce((a, d) => a + Number(d.cantidad), 0) + valor);
        if (suma > Number(l.cantidad)) {
          throw new ConflictException({
            message: `${l.codigo}: con esta cantidad suma ${suma} y lo cotizado es ${Number(l.cantidad)}. Si de verdad se usó más, proponga el cambio de ítems del pedido.`,
            code: 'CANTIDAD_SUPERA_COTIZADO',
            cotizado: Number(l.cantidad),
            lineaId,
          });
        }
        if (previo) {
          await tx.reporteItemDia.update({
            where: { id: previo.id },
            data: { estado, cantidad: valor },
          });
        } else {
          await tx.reporteItemDia.create({
            data: {
              id: uuidv7(),
              lineaId,
              fecha: deDia(fecha),
              estado,
              cantidad: valor,
              createdBy: actor.id,
            },
          });
        }
      }
      await this.reabrir(tx, ticketId);
    });
    return this.obtener(ticketId);
  }

  /** «El reporte está completo»: lo envía a Comercial como documento operativo. Exige al menos una línea con cantidad reportada. */
  async completar(ticketId: string, actor: AuthUser) {
    await this.prisma.$transaction(async (tx) => {
      const t = await this.exigirEquipo(tx, ticketId, actor);
      const filas = await this.paraEnvio(tx, ticketId);
      if (!filas.length) {
        throw new ConflictException({
          message: 'El reporte no tiene cantidades: reparta lo usado en los días del servicio',
          code: 'REPORTE_VACIO',
        });
      }
      await tx.ticket.update({
        where: { id: ticketId },
        data: {
          reporteHerramientasCompletadoAt: new Date(),
          reporteHerramientasCompletadoPor: actor.id,
        },
      });
      const personas = await tx.ticketPersona.findMany({
        where: { ticketId, rol: { in: ['supervisor', 'operador'] } },
        select: { usuarioId: true, rol: true },
      });
      await this.bus.publish(
        tx,
        this.bus.create({
          type: 'operaciones.pumping.reporte_herramientas_completado',
          subject: { type: 'pumping_ticket', id: ticketId },
          data: {
            ticketId,
            ticketNumero: t.ticketNumero,
            pedidoId: t.pedidoId,
            firmadoPor: actor.name,
            firmadoAt: new Date().toISOString(),
            supervisorId: personas.find((p) => p.rol === 'supervisor')?.usuarioId ?? null,
            operadorId:
              personas.find((p) => p.rol === 'operador' && p.usuarioId === actor.id)?.usuarioId ??
              null,
            herramientas: filas,
          },
          actor: { userId: actor.id, role: actor.roleCode },
          traceparent: currentTraceparent(),
        }),
      );
    });
    return this.obtener(ticketId);
  }

  /**
   * Reemplaza las líneas cotizadas del ticket por las vigentes del pedido (copia de otro contenedor). Una línea con días reportados no se
   * borra aunque el pedido ya no la traiga, y su cantidad no baja de lo reportado. Devuelve cuántas líneas quedan.
   */
  async guardarLineas(
    tx: Prisma.TransactionClient,
    ticketId: string,
    lineas: LineaPedido[],
  ): Promise<number> {
    const validas = lineas.filter(
      (l) =>
        typeof l.codigo === 'string' &&
        l.codigo.trim() &&
        Number(l.cantidad) > 0 &&
        typeof l.unidadMedidaId === 'string' &&
        TIPOS_LINEA.includes(l.tipoLinea),
    );
    // si el pedido repite un código, valen todas sus líneas sumadas (el ticket guarda un código una sola vez)
    const porCodigo = new Map<string, LineaPedido & { cantidad: number }>();
    for (const l of validas) {
      const codigo = l.codigo.trim();
      const previa = porCodigo.get(codigo);
      if (previa) previa.cantidad = redondear(previa.cantidad + Number(l.cantidad));
      else porCodigo.set(codigo, { ...l, codigo, cantidad: Number(l.cantidad) });
    }
    const actuales = await tx.ticketLinea.findMany({
      where: { ticketId },
      include: { dias: { select: { cantidad: true } } },
    });
    for (const a of actuales) {
      const nueva = porCodigo.get(a.codigo);
      const reportado = this.reportado(a);
      if (!nueva) {
        if (reportado === 0) await tx.ticketLinea.delete({ where: { id: a.id } });
        continue;
      }
      await tx.ticketLinea.update({
        where: { id: a.id },
        data: {
          descripcion: String(nueva.descripcion ?? '').trim() || a.codigo,
          unidadMedidaId: nueva.unidadMedidaId,
          cantidad: Math.max(nueva.cantidad, reportado),
          tipoLinea: nueva.tipoLinea as TipoLineaItem,
          listaPreciosItemId: nueva.listaPreciosItemId ?? null,
        },
      });
      porCodigo.delete(a.codigo);
    }
    let orden = actuales.reduce((m, a) => Math.max(m, a.orden), 0);
    if (porCodigo.size) {
      await tx.ticketLinea.createMany({
        data: [...porCodigo.values()].map((l) => ({
          id: uuidv7(),
          ticketId,
          orden: ++orden,
          codigo: l.codigo,
          descripcion: String(l.descripcion ?? '').trim() || l.codigo,
          unidadMedidaId: l.unidadMedidaId,
          cantidad: l.cantidad,
          tipoLinea: l.tipoLinea as TipoLineaItem,
          listaPreciosItemId: l.listaPreciosItemId ?? null,
        })),
      });
    }
    return tx.ticketLinea.count({ where: { ticketId } });
  }

  /** Las líneas con cantidad reportada, listas para el evento que recibe Comercial (misma forma que el de FCR). */
  private async paraEnvio(tx: Prisma.TransactionClient, ticketId: string) {
    const lineas = await tx.ticketLinea.findMany({
      where: { ticketId, tipoLinea: { not: 'movilizacion' } },
      include: { dias: { orderBy: { fecha: 'asc' } } },
      orderBy: { orden: 'asc' },
    });
    return lineas
      .filter((l) => this.reportado(l) > 0)
      .map((l) => ({
        listaPreciosItemId: l.listaPreciosItemId,
        codigo: l.codigo,
        nombre: l.descripcion,
        unidadMedidaId: l.unidadMedidaId,
        cantidad: this.reportado(l),
        usos: l.dias.map((d) => ({
          fecha: aDia(d.fecha),
          estado: d.estado,
          cantidad: Number(d.cantidad),
        })),
      }));
  }

  /**
   * Al llegar a la Ejecución operativa el reporte se precarga una sola vez: si el servicio dura un solo día no hay nada que repartir y cada
   * línea se aplica a ese día con su cantidad cotizada; con más de un día el operador decide en qué días se aplicó cada cantidad.
   */
  private async precargarSiCorresponde(ticketId: string, quien: string): Promise<void> {
    const t = await this.prisma.ticket.findUnique({
      where: { id: ticketId },
      select: {
        pasoCodigo: true,
        reportePrecargadoAt: true,
        fechaInicioServicio: true,
        fechaFinServicio: true,
      },
    });
    if (!t || t.reportePrecargadoAt || t.pasoCodigo !== PASO) return;
    await this.prisma.$transaction(async (tx) => {
      const ya = await tx.ticket.updateMany({
        where: { id: ticketId, reportePrecargadoAt: null },
        data: { reportePrecargadoAt: new Date() },
      });
      if (ya.count === 0) return; // otra petición lo está haciendo
      const unSoloDia =
        !!t.fechaInicioServicio &&
        !!t.fechaFinServicio &&
        aDia(t.fechaInicioServicio) === aDia(t.fechaFinServicio);
      if (!unSoloDia || !t.fechaInicioServicio) return;
      const lineas = await tx.ticketLinea.findMany({
        where: { ticketId, tipoLinea: { not: 'movilizacion' }, dias: { none: {} } },
        include: { unidadMedida: { select: { periodo: true } } },
      });
      for (const l of lineas) {
        await tx.reporteItemDia.create({
          data: {
            id: uuidv7(),
            lineaId: l.id,
            fecha: t.fechaInicioServicio,
            estado: 'operacion',
            cantidad: esUnidadPorDia(l.unidadMedida) ? 1 : Number(l.cantidad),
            createdBy: quien,
          },
        });
      }
    });
  }

  private reportado(l: { dias: Array<{ cantidad: Prisma.Decimal | number }> }): number {
    return redondear(l.dias.reduce((a, d) => a + Number(d.cantidad), 0));
  }

  /** Tocar el reporte ya completado lo reabre: hay que completarlo de nuevo para que Comercial reciba la versión nueva. */
  private async reabrir(tx: Prisma.TransactionClient, ticketId: string) {
    await tx.ticket.updateMany({
      where: { id: ticketId, reporteHerramientasCompletadoAt: { not: null } },
      data: { reporteHerramientasCompletadoAt: null, reporteHerramientasCompletadoPor: null },
    });
  }

  private exigirFecha(fecha: string): void {
    const d = new Date(`${fecha}T00:00:00.000Z`);
    if (!FECHA.test(fecha) || Number.isNaN(d.getTime()) || aDia(d) !== fecha) {
      throw new BadRequestException('La fecha no es válida');
    }
  }

  /** El ticket está en Ejecución operativa y quien actúa es del rol del paso y del equipo asignado. */
  private async exigirEquipo(tx: Prisma.TransactionClient, ticketId: string, actor: AuthUser) {
    const t = await tx.ticket.findUnique({
      where: { id: ticketId },
      select: {
        id: true,
        pedidoId: true,
        ticketNumero: true,
        pasoCodigo: true,
        fechaInicioServicio: true,
        fechaFinServicio: true,
        paso: { select: { nombre: true, roles: true } },
        personas: { select: { usuarioId: true } },
      },
    });
    if (!t) throw new NotFoundException('El ticket no existe');
    if (t.pasoCodigo !== PASO) {
      throw new ConflictException('El reporte de herramientas se arma en la Ejecución operativa');
    }
    if (!puedeActuar(t.paso.roles, actor.roleCode)) {
      throw new ForbiddenException(`El paso "${t.paso.nombre}" lo atiende otro rol`);
    }
    if (!puedeActuarEn(t, actor)) {
      throw new ForbiddenException('Solo el equipo asignado a este ticket puede hacerlo');
    }
    return t;
  }
}
