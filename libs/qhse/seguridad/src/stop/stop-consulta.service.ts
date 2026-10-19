import { Injectable, NotFoundException } from '@nestjs/common';
import { aDia, hoyEcuador, aFecha } from '../comun/fechas';
import type { Prisma } from '../generated/client';
import { EstadoItemStop, EstadoStop } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';

/** Consecutivo visible de la tarjeta: STOP-000001. */
export const codigoStop = (numero: number): string => `STOP-${String(numero).padStart(6, '0')}`;

export interface FiltroStop {
  estado?: EstadoStop;
  desde?: string;
  hasta?: string;
  q?: string;
}

const CON_LUGAR = {
  observador: { select: { id: true, nombre: true } },
  observado: { select: { id: true, nombre: true } },
  campo: { select: { id: true, nombre: true } },
  operadora: { select: { id: true, nombreComercial: true } },
} satisfies Prisma.StopTarjetaInclude;

/** Lectura de tarjetas STOP: el formato (catálogo), la bandeja, el detalle y las tendencias (Pareto por subcategoría). */
@Injectable()
export class StopConsultaService {
  constructor(private readonly prisma: PrismaService) {}

  /** El formato DYN-SGI-RE-008 para armar la tarjeta: bloques → subcategorías → ítems. */
  async formato() {
    const subs = await this.prisma.stopSubcategoria.findMany({
      where: { activo: true },
      orderBy: [{ bloque: 'asc' }, { orden: 'asc' }],
      include: {
        items: {
          where: { activo: true },
          orderBy: { orden: 'asc' },
          select: { id: true, nombre: true },
        },
      },
    });
    const por = (bloque: 'acciones' | 'condiciones') =>
      subs
        .filter((s) => s.bloque === bloque)
        .map((s) => ({ id: s.id, codigo: s.codigo, nombre: s.nombre, items: s.items }));
    return { acciones: por('acciones'), condiciones: por('condiciones') };
  }

  async listar(f: FiltroStop = {}) {
    const q = f.q?.trim();
    const filas = await this.prisma.stopTarjeta.findMany({
      where: {
        ...(f.estado ? { estado: f.estado } : {}),
        ...(f.desde || f.hasta
          ? {
              fecha: {
                ...(f.desde ? { gte: aFecha(f.desde) } : {}),
                ...(f.hasta ? { lte: aFecha(f.hasta) } : {}),
              },
            }
          : {}),
        ...(q
          ? {
              OR: [
                { lugar: { contains: q, mode: 'insensitive' } },
                { observador: { nombre: { contains: q, mode: 'insensitive' } } },
              ],
            }
          : {}),
      },
      orderBy: [{ fecha: 'desc' }, { numero: 'desc' }],
      take: 500,
      include: {
        ...CON_LUGAR,
        items: {
          select: {
            estado: true,
            item: { select: { subcategoria: { select: { bloque: true } } } },
          },
        },
      },
    });
    return filas.map((t) => ({
      id: t.id,
      numero: t.numero,
      codigo: codigoStop(t.numero),
      fecha: aDia(t.fecha),
      estado: t.estado,
      observador: t.observador.nombre,
      observado: t.observado?.nombre ?? null,
      campo: t.campo?.nombre ?? null,
      operadora: t.operadora?.nombreComercial ?? null,
      lugar: t.lugar,
      inseguros: t.items.filter((i) => i.estado === EstadoItemStop.inseguro).length,
      segurosCount: t.items.filter((i) => i.estado === EstadoItemStop.seguro).length,
      inseguroEnAcciones: t.items.some(
        (i) => i.estado === EstadoItemStop.inseguro && i.item.subcategoria.bloque === 'acciones',
      ),
      inseguroEnCondiciones: t.items.some(
        (i) => i.estado === EstadoItemStop.inseguro && i.item.subcategoria.bloque === 'condiciones',
      ),
    }));
  }

  async detalle(id: string) {
    const t = await this.prisma.stopTarjeta.findUnique({
      where: { id },
      include: {
        ...CON_LUGAR,
        atendedor: { select: { nombre: true } },
        cerrador: { select: { nombre: true } },
        ticket: { select: { ticketNumero: true, pedidoCodigo: true } },
        items: {
          include: {
            item: {
              select: {
                id: true,
                nombre: true,
                orden: true,
                subcategoria: { select: { id: true, nombre: true, bloque: true, orden: true } },
              },
            },
          },
        },
        historial: {
          include: { actor: { select: { nombre: true } } },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!t) throw new NotFoundException('La tarjeta STOP no existe');
    return {
      id: t.id,
      numero: t.numero,
      codigo: codigoStop(t.numero),
      fecha: aDia(t.fecha),
      estado: t.estado,
      observador: t.observador,
      observado: t.observado,
      campo: t.campo,
      operadora: t.operadora ? { id: t.operadora.id, nombre: t.operadora.nombreComercial } : null,
      lugar: t.lugar,
      contacto: t.contacto,
      ticketId: t.ticketId,
      ticketNumero: t.ticket?.ticketNumero ?? null,
      pedidoCodigo: t.ticket?.pedidoCodigo ?? null,
      fotoArchivoId: t.fotoArchivoId,
      accionesQueObserva: t.accionesQueObserva,
      accionesAccion: t.accionesAccion,
      condicionesQueObserva: t.condicionesQueObserva,
      condicionesAccion: t.condicionesAccion,
      items: t.items
        .sort(
          (a, b) =>
            a.item.subcategoria.orden - b.item.subcategoria.orden || a.item.orden - b.item.orden,
        )
        .map((i) => ({
          itemId: i.item.id,
          item: i.item.nombre,
          subcategoria: i.item.subcategoria.nombre,
          bloque: i.item.subcategoria.bloque,
          estado: i.estado,
        })),
      atendidoPor: t.atendedor?.nombre ?? null,
      atendidoAt: t.atendidoAt,
      atendidoObservacion: t.atendidoObservacion,
      cerradoPor: t.cerrador?.nombre ?? null,
      cerradoAt: t.cerradoAt,
      historial: t.historial.map((h) => ({
        estadoAnterior: h.estadoAnterior,
        estadoNuevo: h.estadoNuevo,
        observacion: h.observacion,
        actor: h.actor.nombre,
        at: h.createdAt,
      })),
    };
  }

  /**
   * Tendencias para el Pareto: ítems inseguros por subcategoría (de mayor a menor), los ítems más repetidos y las tarjetas por mes. Sin
   * fechas, toma los últimos 12 meses.
   */
  async tendencias(desde?: string, hasta?: string) {
    const fin = hasta ?? hoyEcuador();
    const [a, m] = fin.split('-').map(Number);
    const inicio =
      desde ?? `${m === 12 ? a : a - 1}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}-01`;
    const marcados = await this.prisma.stopTarjetaItem.findMany({
      where: { tarjeta: { fecha: { gte: aFecha(inicio), lte: aFecha(fin) } } },
      select: {
        estado: true,
        item: {
          select: {
            id: true,
            nombre: true,
            subcategoria: { select: { id: true, nombre: true, bloque: true } },
          },
        },
      },
    });
    const sub = new Map<
      string,
      { subcategoria: string; bloque: string; inseguros: number; seguros: number }
    >();
    const items = new Map<string, { item: string; subcategoria: string; inseguros: number }>();
    for (const x of marcados) {
      const s = x.item.subcategoria;
      const fila = sub.get(s.id) ?? {
        subcategoria: s.nombre,
        bloque: s.bloque,
        inseguros: 0,
        seguros: 0,
      };
      if (x.estado === EstadoItemStop.inseguro) {
        fila.inseguros++;
        const it = items.get(x.item.id) ?? {
          item: x.item.nombre,
          subcategoria: s.nombre,
          inseguros: 0,
        };
        it.inseguros++;
        items.set(x.item.id, it);
      } else fila.seguros++;
      sub.set(s.id, fila);
    }
    const tarjetas = await this.prisma.stopTarjeta.findMany({
      where: { fecha: { gte: aFecha(inicio), lte: aFecha(fin) } },
      select: { fecha: true },
    });
    const porMes = new Map<string, number>();
    for (const t of tarjetas)
      porMes.set(aDia(t.fecha).slice(0, 7), (porMes.get(aDia(t.fecha).slice(0, 7)) ?? 0) + 1);
    return {
      desde: inicio,
      hasta: fin,
      totalTarjetas: tarjetas.length,
      porSubcategoria: [...sub.values()].sort((x, y) => y.inseguros - x.inseguros),
      itemsMasRepetidos: [...items.values()].sort((x, y) => y.inseguros - x.inseguros).slice(0, 10),
      porMes: [...porMes.entries()].sort().map(([mes, tarjetas]) => ({ mes, tarjetas })),
    };
  }
}
