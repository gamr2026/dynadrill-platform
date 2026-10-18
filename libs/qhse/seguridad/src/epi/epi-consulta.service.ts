import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '../generated/client';
import { EstadoEpi } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import { codigoDe } from './epi-tipos';

export interface FiltroEntregas {
  estado?: EstadoEpi;
  ticketId?: string;
  trabajadorId?: string;
  q?: string;
}

const INCLUDE_LISTA = {
  trabajador: { include: { perfil: true } },
  ticket: true,
  lugar: true,
  _count: { select: { items: true } },
} satisfies Prisma.EpiEntregaInclude;

const INCLUDE_DETALLE = {
  trabajador: { include: { perfil: true, rol: true } },
  ticket: true,
  lugar: true,
  items: { include: { elemento: true, talla: true }, orderBy: { elemento: { nombre: 'asc' } } },
  firmaTrabajador: true,
  firmaTh: true,
  aprobador: true,
  rechazador: true,
  despachador: true,
  historial: { include: { actor: true }, orderBy: { createdAt: 'asc' } },
} satisfies Prisma.EpiEntregaInclude;

type EntregaLista = Prisma.EpiEntregaGetPayload<{ include: typeof INCLUDE_LISTA }>;
type EntregaDetalle = Prisma.EpiEntregaGetPayload<{ include: typeof INCLUDE_DETALLE }>;

/** Lectura de las entregas de EPI y de sus catálogos. No cambia nada. */
@Injectable()
export class EpiConsultaService {
  constructor(private readonly prisma: PrismaService) {}

  elementos() {
    return this.prisma.epiElemento.findMany({
      where: { activo: true },
      orderBy: { nombre: 'asc' },
      select: { id: true, codigo: true, nombre: true, tipoTalla: true },
    });
  }

  tallas() {
    return this.prisma.epiTalla.findMany({
      where: { activo: true },
      orderBy: [{ tipo: 'asc' }, { orden: 'asc' }],
      select: { id: true, tipo: true, codigo: true },
    });
  }

  /** Bases y bodegas donde se puede entregar el EPI (catálogo `catalogos.bodega`). */
  lugares() {
    return this.prisma.catBodega.findMany({
      where: { habilitado: true },
      orderBy: { nombre: 'asc' },
      select: { id: true, nombre: true },
    });
  }

  async listar(f: FiltroEntregas) {
    const q = f.q?.trim();
    const filas = await this.prisma.epiEntrega.findMany({
      where: {
        ...(f.estado ? { estado: f.estado } : {}),
        ...(f.ticketId ? { ticketId: f.ticketId } : {}),
        ...(f.trabajadorId ? { trabajadorId: f.trabajadorId } : {}),
        ...(q
          ? {
              OR: [
                { trabajador: { nombre: { contains: q, mode: 'insensitive' as const } } },
                { trabajador: { perfil: { cedula: { contains: q } } } },
                { lugar: { nombre: { contains: q, mode: 'insensitive' as const } } },
                { ticket: { pedidoCodigo: { contains: q, mode: 'insensitive' as const } } },
                ...(/^\d+$/.test(q)
                  ? [{ numero: Number(q) }, { ticket: { ticketNumero: Number(q) } }]
                  : []),
              ],
            }
          : {}),
      },
      include: INCLUDE_LISTA,
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    return filas.map((e) => this.resumen(e));
  }

  async detalle(id: string) {
    const e = await this.prisma.epiEntrega.findUnique({ where: { id }, include: INCLUDE_DETALLE });
    if (!e) throw new NotFoundException('La entrega de EPI no existe');
    return this.completo(e);
  }

  private ticketDe(t: EntregaLista['ticket']) {
    return t
      ? {
          id: t.ticketId,
          numero: t.ticketNumero,
          pedidoId: t.pedidoId,
          pedidoCodigo: t.pedidoCodigo,
        }
      : null;
  }

  private resumen(e: EntregaLista) {
    return {
      id: e.id,
      numero: e.numero,
      codigo: codigoDe(e.numero),
      estado: e.estado,
      lugar: e.lugar ? { id: e.lugar.id, nombre: e.lugar.nombre } : null,
      trabajador: {
        id: e.trabajador.id,
        nombre: e.trabajador.nombre,
        cedula: e.trabajador.perfil?.cedula ?? null,
        cargo: e.trabajador.perfil?.cargo ?? null,
      },
      ticket: this.ticketDe(e.ticket),
      renglones: e._count.items,
      firmadaPorTrabajador: e.firmaTrabajadorAt !== null,
      firmadaPorTalentoHumano: e.firmaThAt !== null,
      createdAt: e.createdAt,
    };
  }

  private completo(e: EntregaDetalle) {
    const persona = (u: { id: string; nombre: string } | null, at: Date | null) =>
      u && at ? { usuarioId: u.id, nombre: u.nombre, at } : null;
    return {
      id: e.id,
      numero: e.numero,
      codigo: codigoDe(e.numero),
      estado: e.estado,
      lugar: e.lugar ? { id: e.lugar.id, nombre: e.lugar.nombre } : null,
      trabajador: {
        id: e.trabajador.id,
        nombre: e.trabajador.nombre,
        cedula: e.trabajador.perfil?.cedula ?? null,
        cargo: e.trabajador.perfil?.cargo ?? e.trabajador.rol.nombre,
      },
      ticket: this.ticketDe(e.ticket),
      renglones: e.items.map((i) => ({
        id: i.id,
        elementoId: i.elementoId,
        elemento: i.elemento.nombre,
        cantidad: i.cantidad,
        tallaId: i.tallaId,
        talla: i.talla?.codigo ?? null,
        recibioCapacitacion: i.recibioCapacitacion,
        observaciones: i.observaciones,
        entregadoEl: i.entregadoEl.toISOString().slice(0, 10),
      })),
      firmaTrabajador: persona(e.firmaTrabajador, e.firmaTrabajadorAt),
      firmaTalentoHumano: persona(e.firmaTh, e.firmaThAt),
      aprobado: persona(e.aprobador, e.aprobadoAt),
      rechazado:
        e.rechazador && e.rechazadoAt
          ? { ...persona(e.rechazador, e.rechazadoAt), motivo: e.motivoRechazo }
          : null,
      despachado: persona(e.despachador, e.despachadoAt),
      historial: e.historial.map((h) => ({
        estadoAnterior: h.estadoAnterior,
        estadoNuevo: h.estadoNuevo,
        motivo: h.motivo,
        actor: h.actor?.nombre ?? null,
        at: h.createdAt,
      })),
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
    };
  }
}
