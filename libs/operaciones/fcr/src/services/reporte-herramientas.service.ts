import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AuthUser } from '@dyn/common';
import { uuidv7 } from '@dyn/utils';
import { REQ } from '../catalog/sembrar-pasos';
import type { EstadoItemReporte, Prisma } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import { exigirDentroDelServicio, exigirFecha } from './bitacora.service';
import { RequisitosService } from './requisitos.service';
import { TicketsService } from './tickets.service';

const PASO = 'ejecucion_operativa';
const deDia = (f: string) => new Date(`${f}T00:00:00.000Z`);
const aDia = (d: Date) => d.toISOString().slice(0, 10);
const num = (d: Prisma.Decimal | null) => (d === null ? null : Number(d));
/** Una fila es «por día» cuando su unidad se mide en días (período día en el catálogo): se reporta con marcas por día. */
export const esUnidadPorDia = (unidad: { periodo: string | null } | null | undefined): boolean =>
  unidad?.periodo === 'dia';

/** Cantidad real de una fila: la suma de las cantidades de sus días (cada marca de una fila por día vale 1). */
export const cantidadDeFila = (f: { dias: Array<{ cantidad: Prisma.Decimal | number }> }): number =>
  Math.round(f.dias.reduce((a, d) => a + Number(d.cantidad), 0) * 1000) / 1000;

/** Lo cotizado por código: la suma de las líneas del pedido con ese código. */
const cotizadoPorCodigo = (
  lineas: Array<{ codigo: string; cantidad: Prisma.Decimal | number }>,
): Map<string, number> => {
  const m = new Map<string, number>();
  for (const l of lineas) m.set(l.codigo, (m.get(l.codigo) ?? 0) + Number(l.cantidad));
  return m;
};

export interface AgregarItemEntrada {
  /** Ítem de la lista de precios del cliente (en Comercial); vacío si el ítem no está enlazado. */
  listaPreciosItemId?: string | null;
  codigo: string;
  descripcion: string;
  /** Unidad del catálogo compartido (`catalogos.unidad_medida`). */
  unidadMedidaId?: string | null;
  serie?: string | null;
}

/**
 * Reporte de Herramientas (DYN-FCR-RE-008) de un ticket: una matriz ítem × día. Las filas son los códigos de la lista de precios del cliente (nace
 * precargado con todos los ítems cotizados del pedido, también la movilización); el operador reparte la cantidad de cada ítem en los días del servicio: una
 * marca que vale 1 en las filas de tiempo y la cantidad aplicada ese día en las demás. De la suma de cada fila salen la guía de remisión, la
 * prefactura y la orden de trabajo. Cualquier cambio obliga a confirmar de nuevo el listado antes de finalizar. La selección de herramientas
 * físicas no es la fuente del reporte: sirve para las inspecciones, el registro de completación y el retorno, y propone las series.
 */
@Injectable()
export class ReporteHerramientasService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tickets: TicketsService,
    private readonly requisitos: RequisitosService,
  ) {}

  /** `actorId`: quien consulta; si se indica y el reporte aún no se precargó, esa persona queda como autora de la precarga. */
  async obtener(ticketId: string, actorId?: string) {
    if (actorId) await this.precargarSiCorresponde(ticketId, actorId);
    const t = await this.prisma.ticket.findUnique({
      where: { id: ticketId },
      select: { id: true, fechaInicioServicio: true, fechaFinServicio: true },
    });
    if (!t) throw new NotFoundException('El ticket no existe');
    const [filas, herramientas, confirmado, lineas] = await Promise.all([
      this.prisma.reporteItem.findMany({
        where: { ticketId },
        include: {
          dias: { orderBy: { fecha: 'asc' } },
          unidadMedida: { select: { nombre: true } },
        },
        orderBy: { orden: 'asc' },
      }),
      this.prisma.ticketHerramienta.findMany({
        where: { ticketId, numeroSerie: { not: null } },
        select: { codigoPedido: true, numeroSerie: true },
      }),
      this.prisma.ticketRequisito.count({
        where: { ticketId, requisitoCodigo: REQ.listadoUsoConfirmado, estado: 'cumplido' },
      }),
      this.prisma.ticketLinea.findMany({
        where: { ticketId },
        select: { codigo: true, cantidad: true },
      }),
    ]);
    const cotizado = cotizadoPorCodigo(lineas);
    return {
      listadoConfirmado: confirmado > 0,
      fechaInicio: t.fechaInicioServicio ? aDia(t.fechaInicioServicio) : null,
      fechaFin: t.fechaFinServicio ? aDia(t.fechaFinServicio) : null,
      items: filas.map((f) => ({
        id: f.id,
        orden: f.orden,
        listaPreciosItemId: f.listaPreciosItemId,
        codigo: f.codigo,
        descripcion: f.descripcion,
        unidad: f.unidadMedida?.nombre ?? null,
        unidadMedidaId: f.unidadMedidaId,
        porDia: f.porDia,
        serie: f.serie,
        cantidad: cantidadDeFila(f),
        /** Lo cotizado por Ventas para ese código (las filas con el mismo código comparten ese tope). */
        cotizado: cotizado.get(f.codigo) ?? 0,
        dias: f.dias.map((d) => ({
          fecha: aDia(d.fecha),
          estado: d.estado,
          cantidad: Number(d.cantidad),
        })),
        // series de las herramientas físicas que el ticket tiene para ese código (para proponerlas al operador)
        seriesSugeridas: [
          ...new Set(
            herramientas
              .filter((h) => h.codigoPedido === f.codigo && h.numeroSerie)
              .map((h) => h.numeroSerie as string),
          ),
        ],
      })),
    };
  }

  async agregarItem(ticketId: string, e: AgregarItemEntrada, actor: AuthUser) {
    const codigo = e.codigo?.trim();
    const descripcion = e.descripcion?.trim();
    if (!codigo || !descripcion)
      throw new BadRequestException('Indique el código y la descripción');
    const serie = e.serie?.trim() || null;
    await this.prisma.$transaction(async (tx) => {
      await this.exigirOperador(tx, ticketId, actor);
      const unidad = e.unidadMedidaId
        ? await tx.catUnidadMedida.findUnique({
            where: { id: e.unidadMedidaId },
            select: { periodo: true },
          })
        : null;
      if (e.unidadMedidaId && !unidad)
        throw new BadRequestException('La unidad no existe en el catálogo');
      const porDia = esUnidadPorDia(unidad);
      const ultimo = await tx.reporteItem.aggregate({
        where: { ticketId },
        _max: { orden: true },
      });
      const repetido = await tx.reporteItem.findFirst({
        where: { ticketId, codigo, serie },
        select: { id: true },
      });
      if (repetido) {
        throw new ConflictException({
          message: serie
            ? `Ya hay una fila con el código ${codigo} y la serie ${serie}`
            : `Ya hay una fila con el código ${codigo}: use otra serie si es otro equipo`,
          code: 'ITEM_REPETIDO',
        });
      }
      await tx.reporteItem.create({
        data: {
          id: uuidv7(),
          ticketId,
          orden: (ultimo._max.orden ?? 0) + 1,
          listaPreciosItemId: e.listaPreciosItemId ?? null,
          codigo,
          descripcion,
          unidadMedidaId: e.unidadMedidaId ?? null,
          porDia,
          serie,
          createdBy: actor.id,
          updatedBy: actor.id,
        },
      });
      await this.requisitos.reabrir(tx, { ticketId, codigo: REQ.listadoUsoConfirmado });
    });
    return this.obtener(ticketId);
  }

  /** Cambia la serie de una fila (las cantidades se reparten por día con `marcarDia`). */
  async actualizarItem(
    ticketId: string,
    itemId: string,
    cambios: { serie?: string | null },
    actor: AuthUser,
  ) {
    await this.prisma.$transaction(async (tx) => {
      await this.exigirOperador(tx, ticketId, actor);
      await this.fila(tx, ticketId, itemId);
      const datos: Prisma.ReporteItemUpdateInput = { updatedBy: actor.id };
      if (cambios.serie !== undefined) datos.serie = cambios.serie?.trim() || null;
      try {
        await tx.reporteItem.update({ where: { id: itemId }, data: datos });
      } catch {
        throw new ConflictException({
          message: 'Ya hay una fila con ese código y esa serie',
          code: 'ITEM_REPETIDO',
        });
      }
      await this.requisitos.reabrir(tx, { ticketId, codigo: REQ.listadoUsoConfirmado });
    });
    return this.obtener(ticketId);
  }

  async quitarItem(ticketId: string, itemId: string, actor: AuthUser) {
    await this.prisma.$transaction(async (tx) => {
      await this.exigirOperador(tx, ticketId, actor);
      await this.fila(tx, ticketId, itemId);
      await tx.reporteItem.delete({ where: { id: itemId } });
      await this.requisitos.reabrir(tx, { ticketId, codigo: REQ.listadoUsoConfirmado });
    });
    return this.obtener(ticketId);
  }

  /**
   * Pone (o quita con `estado = null`) la celda de un día. En una fila por día la marca vale 1; en las demás hay que indicar la cantidad aplicada
   * ese día. El día va dentro de las fechas del servicio.
   */
  async marcarDia(
    ticketId: string,
    itemId: string,
    fecha: string,
    estado: EstadoItemReporte | null,
    cantidad: number | undefined,
    actor: AuthUser,
  ) {
    exigirFecha(fecha);
    await this.prisma.$transaction(async (tx) => {
      const t = await this.exigirOperador(tx, ticketId, actor);
      exigirDentroDelServicio(t, fecha);
      const f = await this.fila(tx, ticketId, itemId);
      let valor = 1;
      if (estado !== null && !f.porDia) {
        if (!(typeof cantidad === 'number' && cantidad > 0)) {
          throw new BadRequestException('Escriba la cantidad aplicada ese día (mayor que cero)');
        }
        valor = cantidad;
      }
      const previo = await tx.reporteItemDia.findUnique({
        where: { itemId_fecha: { itemId, fecha: deDia(fecha) } },
      });
      if (estado !== null)
        await this.exigirDentroDeLoCotizado(tx, ticketId, f.codigo, itemId, previo?.id, valor);
      if (estado === null) {
        if (previo) await tx.reporteItemDia.delete({ where: { id: previo.id } });
      } else if (previo) {
        await tx.reporteItemDia.update({
          where: { id: previo.id },
          data: { estado, cantidad: valor },
        });
      } else {
        await tx.reporteItemDia.create({
          data: {
            id: uuidv7(),
            itemId,
            fecha: deDia(fecha),
            estado,
            cantidad: valor,
            createdBy: actor.id,
          },
        });
      }
      await this.requisitos.reabrir(tx, { ticketId, codigo: REQ.listadoUsoConfirmado });
    });
    return this.obtener(ticketId);
  }

  /** «El reporte está completo»: verificación previa a finalizar la ejecución (no se confirma un reporte vacío ni una fila sin cantidad). */
  async confirmar(ticketId: string, confirmado: boolean, actor: AuthUser) {
    await this.prisma.$transaction(async (tx) => {
      await this.exigirOperador(tx, ticketId, actor);
      const clave = { ticketId, codigo: REQ.listadoUsoConfirmado };
      if (confirmado) {
        const filas = await tx.reporteItem.findMany({
          where: { ticketId },
          include: { dias: { select: { cantidad: true } } },
        });
        if (!filas.length) {
          throw new ConflictException({
            message:
              'El reporte no tiene filas: agregue los códigos de la lista de precios que se usaron',
            code: 'REPORTE_VACIO',
          });
        }
        const sinCantidad = filas.filter((f) => cantidadDeFila(f) <= 0);
        if (sinCantidad.length) {
          throw new ConflictException({
            message: `Reparta la cantidad en los días de: ${sinCantidad.map((f) => f.codigo).join(', ')} (o quite la fila)`,
            code: 'FILA_SIN_CANTIDAD',
          });
        }
        await this.requisitos.marcar(tx, clave, 'sistema', actor.id);
      } else await this.requisitos.reabrir(tx, clave);
    });
    return this.obtener(ticketId);
  }

  /** Las filas con su cantidad real, listas para el evento que recibe Comercial. */
  async paraEnvio(tx: Prisma.TransactionClient, ticketId: string) {
    const filas = await tx.reporteItem.findMany({
      where: { ticketId },
      include: { dias: { orderBy: { fecha: 'asc' } } },
      orderBy: { orden: 'asc' },
    });
    return filas.map((f) => ({
      listaPreciosItemId: f.listaPreciosItemId,
      codigo: f.codigo,
      nombre: f.descripcion,
      unidadMedidaId: f.unidadMedidaId ?? undefined,
      serie: f.serie ?? undefined,
      cantidad: cantidadDeFila(f),
      // todas las filas envían sus días con la cantidad aplicada (en las de por día cada marca vale 1): la suma de las cantidades de los
      // días es la cantidad total de la fila, y Comercial la comprueba contra ella
      usos: f.dias.map((d) => ({
        fecha: aDia(d.fecha),
        estado: d.estado,
        cantidad: Number(d.cantidad),
      })),
    }));
  }

  /**
   * Al llegar a la Ejecución operativa el reporte se precarga una sola vez con todos los ítems cotizados del pedido (la movilización también va, como en los reportes reales): así el operador
   * solo reparte las cantidades en los días. Lo que quite no vuelve a aparecer.
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
      const lineas = await tx.ticketLinea.findMany({
        where: { ticketId },
        orderBy: { orden: 'asc' },
        include: { unidadMedida: { select: { periodo: true } } },
      });
      // si el servicio dura un solo día no hay nada que repartir: cada ítem se aplica a ese día con su cantidad cotizada. Con más de un día
      // el operador decide en qué días se aplicó cada cantidad.
      const unSoloDia =
        !!t.fechaInicioServicio &&
        !!t.fechaFinServicio &&
        aDia(t.fechaInicioServicio) === aDia(t.fechaFinServicio);
      const existentes = await tx.reporteItem.findMany({
        where: { ticketId },
        select: { codigo: true, serie: true, orden: true },
      });
      const usados = new Set(existentes.filter((x) => !x.serie).map((x) => x.codigo));
      let orden = existentes.reduce((m, x) => Math.max(m, x.orden), 0);
      for (const l of lineas) {
        if (usados.has(l.codigo)) continue; // el operador ya agregó ese código
        usados.add(l.codigo);
        const porDia = esUnidadPorDia(l.unidadMedida);
        const id = uuidv7();
        await tx.reporteItem.create({
          data: {
            id,
            ticketId,
            orden: ++orden,
            listaPreciosItemId: l.listaPreciosItemId,
            codigo: l.codigo,
            descripcion: l.descripcion,
            unidadMedidaId: l.unidadMedidaId,
            porDia,
            createdBy: quien,
            updatedBy: quien,
          },
        });
        if (unSoloDia && t.fechaInicioServicio) {
          await tx.reporteItemDia.create({
            data: {
              id: uuidv7(),
              itemId: id,
              fecha: t.fechaInicioServicio,
              estado: 'operacion',
              cantidad: porDia ? 1 : Number(l.cantidad),
              createdBy: quien,
            },
          });
        }
      }
    });
  }

  /**
   * Lo reportado de un código no puede superar lo que Ventas cotizó (suma de las filas con ese código, cada una con sus días). Para reportar más,
   * el equipo propone el cambio de ítems del pedido y, aprobado, lo cotizado sube.
   */
  private async exigirDentroDeLoCotizado(
    tx: Prisma.TransactionClient,
    ticketId: string,
    codigo: string,
    itemId: string,
    celdaId: string | undefined,
    valor: number,
  ): Promise<void> {
    const [lineas, celdas] = await Promise.all([
      tx.ticketLinea.findMany({
        where: { ticketId, codigo },
        select: { codigo: true, cantidad: true },
      }),
      tx.reporteItemDia.findMany({
        where: { item: { ticketId, codigo }, ...(celdaId ? { id: { not: celdaId } } : {}) },
        select: { cantidad: true },
      }),
    ]);
    const tope = cotizadoPorCodigo(lineas).get(codigo) ?? 0;
    const suma =
      Math.round((celdas.reduce((a, c) => a + Number(c.cantidad), 0) + valor) * 1000) / 1000;
    if (suma > tope) {
      throw new ConflictException({
        message:
          tope > 0
            ? `${codigo}: con esta cantidad suma ${suma} y lo cotizado es ${tope}. Si de verdad se usó más, proponga el cambio de ítems del pedido.`
            : `${codigo} no está en lo cotizado del pedido: proponga el cambio de ítems para poder reportarlo.`,
        code: 'CANTIDAD_SUPERA_COTIZADO',
        cotizado: tope,
        itemId,
      });
    }
  }

  private async fila(tx: Prisma.TransactionClient, ticketId: string, itemId: string) {
    const f = await tx.reporteItem.findFirst({ where: { id: itemId, ticketId } });
    if (!f) throw new NotFoundException('La fila no existe en el reporte de este ticket');
    return f;
  }

  private async exigirOperador(tx: Prisma.TransactionClient, ticketId: string, actor: AuthUser) {
    const t = await this.tickets.cargarEnTx(tx, ticketId);
    if (t.pasoCodigo !== PASO) {
      throw new ConflictException('El reporte de herramientas se arma en la Ejecución operativa');
    }
    this.tickets.exigirActuar(t, actor);
    return t;
  }
}
