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
const PERIODO_DIA = /d[ií]a/i;

/** Una unidad de la lista de precios es «por día» cuando se mide en días: esas filas se reportan con marcas por día. */
export const esUnidadPorDia = (unidad: string | null | undefined): boolean =>
  !!unidad && PERIODO_DIA.test(unidad);

/** Cantidad real de una fila: las marcas de los días si es por día; si no, la cantidad escrita. */
export const cantidadDeFila = (f: {
  porDia: boolean;
  cantidad: Prisma.Decimal | number | null;
  dias: unknown[];
}): number => (f.porDia ? f.dias.length : Number(f.cantidad ?? 0));

export interface AgregarItemEntrada {
  /** Ítem de la lista de precios del cliente (en Comercial). */
  listaPreciosItemId: string;
  codigo: string;
  descripcion: string;
  unidad?: string | null;
  serie?: string | null;
  /** Solo si la unidad no es de tiempo. */
  cantidad?: number;
}

/**
 * Reporte de Herramientas (DYN-FCR-RE-008) de un ticket: filas por código de la lista de precios del cliente, con su serie y su cantidad real
 * (marcas por día si la unidad es de tiempo; si no, la cantidad escrita). De esa cantidad salen la guía de remisión, la prefactura y la orden de
 * trabajo. Se arma en la Ejecución operativa; cualquier cambio obliga a confirmar de nuevo el listado antes de finalizar. La selección de
 * herramientas físicas no es la fuente del reporte: sirve para las inspecciones, el registro de completación y el retorno, y propone las series.
 */
@Injectable()
export class ReporteHerramientasService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tickets: TicketsService,
    private readonly requisitos: RequisitosService,
  ) {}

  async obtener(ticketId: string) {
    const t = await this.prisma.ticket.findUnique({
      where: { id: ticketId },
      select: { id: true, fechaInicioServicio: true, fechaFinServicio: true },
    });
    if (!t) throw new NotFoundException('El ticket no existe');
    const [filas, herramientas, confirmado] = await Promise.all([
      this.prisma.reporteItem.findMany({
        where: { ticketId },
        include: { dias: { orderBy: { fecha: 'asc' } } },
        orderBy: { orden: 'asc' },
      }),
      this.prisma.ticketHerramienta.findMany({
        where: { ticketId, numeroSerie: { not: null } },
        select: { codigoPedido: true, numeroSerie: true },
      }),
      this.prisma.ticketRequisito.count({
        where: { ticketId, requisitoCodigo: REQ.listadoUsoConfirmado, estado: 'cumplido' },
      }),
    ]);
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
        unidad: f.unidad,
        porDia: f.porDia,
        serie: f.serie,
        cantidad: cantidadDeFila(f),
        dias: f.dias.map((d) => ({ fecha: aDia(d.fecha), estado: d.estado })),
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
    const porDia = esUnidadPorDia(e.unidad);
    if (porDia && e.cantidad !== undefined) {
      throw new BadRequestException('Una fila por día se reporta con marcas, no con cantidad');
    }
    if (!porDia && !(typeof e.cantidad === 'number' && e.cantidad > 0)) {
      throw new BadRequestException('Escriba la cantidad real (mayor que cero)');
    }
    await this.prisma.$transaction(async (tx) => {
      await this.exigirOperador(tx, ticketId, actor);
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
          listaPreciosItemId: e.listaPreciosItemId,
          codigo,
          descripcion,
          unidad: e.unidad?.trim() || null,
          porDia,
          cantidad: porDia ? null : e.cantidad,
          serie,
          createdBy: actor.id,
          updatedBy: actor.id,
        },
      });
      await this.requisitos.reabrir(tx, { ticketId, codigo: REQ.listadoUsoConfirmado });
    });
    return this.obtener(ticketId);
  }

  /** Cambia la serie o, si la fila no es por día, la cantidad. */
  async actualizarItem(
    ticketId: string,
    itemId: string,
    cambios: { serie?: string | null; cantidad?: number },
    actor: AuthUser,
  ) {
    await this.prisma.$transaction(async (tx) => {
      await this.exigirOperador(tx, ticketId, actor);
      const f = await this.fila(tx, ticketId, itemId);
      const datos: Prisma.ReporteItemUpdateInput = { updatedBy: actor.id };
      if (cambios.cantidad !== undefined) {
        if (f.porDia)
          throw new BadRequestException('Una fila por día se reporta con marcas, no con cantidad');
        if (!(cambios.cantidad > 0))
          throw new BadRequestException('La cantidad debe ser mayor que cero');
        datos.cantidad = cambios.cantidad;
      }
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

  /** Marca (o desmarca con `estado = null`) un día de una fila por día. El día va dentro de las fechas del servicio. */
  async marcarDia(
    ticketId: string,
    itemId: string,
    fecha: string,
    estado: EstadoItemReporte | null,
    actor: AuthUser,
  ) {
    exigirFecha(fecha);
    await this.prisma.$transaction(async (tx) => {
      const t = await this.exigirOperador(tx, ticketId, actor);
      exigirDentroDelServicio(t, fecha);
      const f = await this.fila(tx, ticketId, itemId);
      if (!f.porDia) {
        throw new BadRequestException('Esta fila no es por día: escriba su cantidad');
      }
      const previo = await tx.reporteItemDia.findUnique({
        where: { itemId_fecha: { itemId, fecha: deDia(fecha) } },
      });
      if (estado === null) {
        if (previo) await tx.reporteItemDia.delete({ where: { id: previo.id } });
      } else if (previo) {
        await tx.reporteItemDia.update({ where: { id: previo.id }, data: { estado } });
      } else {
        await tx.reporteItemDia.create({
          data: { id: uuidv7(), itemId, fecha: deDia(fecha), estado, createdBy: actor.id },
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
          include: { dias: { select: { id: true } } },
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
            message: `Marque al menos un día en: ${sinCantidad.map((f) => f.codigo).join(', ')} (o quite la fila)`,
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
      unidad: f.unidad ?? undefined,
      serie: f.serie ?? undefined,
      cantidad: cantidadDeFila(f),
      usos: f.dias.map((d) => ({ fecha: aDia(d.fecha), estado: d.estado })),
    }));
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
