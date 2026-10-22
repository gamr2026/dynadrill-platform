import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** Consecutivo visible del derrame: DER-000001. */
export const codigoDerrame = (numero: number): string => `DER-${String(numero).padStart(6, '0')}`;

/** Lo que decide si un derrame obliga a notificar al MAE o a escalar a emergencia: la ubicación o la banda de volumen (columnas, no nombres). */
export interface ReglasDerrame {
  ubicacion: { exigeNotificacionMae: boolean; escalaAEmergencia: boolean };
  banda: { exigeNotificacionMae: boolean; escalaAEmergencia: boolean };
}

/** HSE-AMBIENTAL-002: la notificación al MAE es obligatoria si la banda o la ubicación la exigen (p. ej. mayor, o cuerpo de agua con cualquier volumen). */
export const requiereNotificacionMae = (d: ReglasDerrame): boolean =>
  d.banda.exigeNotificacionMae || d.ubicacion.exigeNotificacionMae;

/** HSE-MASTER-001: un derrame mayor o en cuerpo de agua escala a Emergencia Mayor. */
export const escalaAEmergencia = (d: ReglasDerrame): boolean =>
  d.banda.escalaAEmergencia || d.ubicacion.escalaAEmergencia;

export interface FiltroDerrames {
  estado?: 'activo' | 'contenido' | 'cerrado';
  ticketId?: string;
  q?: string;
}

const INCLUIR = {
  ubicacion: true,
  banda: true,
} as const;

/** Lectura de derrames: catálogos del formulario, bandeja y detalle. */
@Injectable()
export class DerramesConsultaService {
  constructor(private readonly prisma: PrismaService) {}

  /** Catálogos del formulario de alerta (los usa quien reporta, aunque no vea la bandeja) y los servicios que puede elegir. */
  async catalogos() {
    const [ubicaciones, bandas, tickets] = await Promise.all([
      this.prisma.derrameUbicacion.findMany({
        where: { activo: true },
        orderBy: { orden: 'asc' },
        select: { id: true, codigo: true, nombre: true },
      }),
      this.prisma.derrameBandaVolumen.findMany({
        where: { activo: true },
        orderBy: { orden: 'asc' },
        select: {
          id: true,
          codigo: true,
          nombre: true,
          desdeBarriles: true,
          hastaBarriles: true,
          porConfirmar: true,
        },
      }),
      this.prisma.ticketRef.findMany({
        orderBy: { updatedAt: 'desc' },
        take: 100,
        select: {
          ticketId: true,
          ticketNumero: true,
          pedidoCodigo: true,
          cliente: true,
          pozo: true,
        },
      }),
    ]);
    return {
      ubicaciones,
      bandas: bandas.map((b) => ({
        ...b,
        desdeBarriles: Number(b.desdeBarriles),
        hastaBarriles: b.hastaBarriles === null ? null : Number(b.hastaBarriles),
      })),
      tickets,
    };
  }

  async listar(filtro: FiltroDerrames = {}) {
    const q = filtro.q?.trim();
    const filas = await this.prisma.derrame.findMany({
      where: {
        ...(filtro.estado ? { estado: filtro.estado } : {}),
        ...(filtro.ticketId ? { ticketId: filtro.ticketId } : {}),
        ...(q
          ? {
              OR: [
                { descripcion: { contains: q, mode: 'insensitive' } },
                { ubicacionFisica: { contains: q, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      orderBy: { numero: 'desc' },
      include: INCLUIR,
      take: 300,
    });
    const tickets = await this.tickets(filas.map((f) => f.ticketId));
    return filas.map((d) => ({
      id: d.id,
      numero: d.numero,
      codigo: codigoDerrame(d.numero),
      estado: d.estado,
      descripcion: d.descripcion,
      ubicacion: { codigo: d.ubicacion.codigo, nombre: d.ubicacion.nombre },
      banda: { codigo: d.banda.codigo, nombre: d.banda.nombre },
      requiereNotificacionMae: requiereNotificacionMae(d),
      escalaAEmergencia: escalaAEmergencia(d),
      ticketId: d.ticketId,
      ticketNumero: d.ticketId ? (tickets.get(d.ticketId)?.ticketNumero ?? null) : null,
      pedidoCodigo: d.ticketId ? (tickets.get(d.ticketId)?.pedidoCodigo ?? null) : null,
      activadoAt: d.activadoAt,
    }));
  }

  async detalle(id: string) {
    const d = await this.prisma.derrame.findUnique({
      where: { id },
      include: { ...INCLUIR, historial: { orderBy: { createdAt: 'asc' } } },
    });
    if (!d) throw new NotFoundException('El derrame no existe');
    const [tickets, nombres] = await Promise.all([
      this.tickets([d.ticketId]),
      this.nombres([d.activadoPor, ...d.historial.map((h) => h.actorId)]),
    ]);
    const t = d.ticketId ? tickets.get(d.ticketId) : undefined;
    return {
      id: d.id,
      numero: d.numero,
      codigo: codigoDerrame(d.numero),
      estado: d.estado,
      descripcion: d.descripcion,
      ubicacionFisica: d.ubicacionFisica,
      ubicacion: { codigo: d.ubicacion.codigo, nombre: d.ubicacion.nombre },
      banda: {
        codigo: d.banda.codigo,
        nombre: d.banda.nombre,
        porConfirmar: d.banda.porConfirmar,
      },
      /** Obligatoria si la banda o la ubicación la exigen. */
      requiereNotificacionMae: requiereNotificacionMae(d),
      /** Mayor o en cuerpo de agua: escala a Emergencia Mayor. */
      escalaAEmergencia: escalaAEmergencia(d),
      ticketId: d.ticketId,
      ticketNumero: t?.ticketNumero ?? null,
      pedidoCodigo: t?.pedidoCodigo ?? null,
      cliente: t?.cliente ?? null,
      campo: t?.campo ?? null,
      pozo: t?.pozo ?? null,
      activadoPor: nombres.get(d.activadoPor) ?? null,
      activadoAt: d.activadoAt,
      historial: d.historial.map((h) => ({
        estado: h.estadoNuevo,
        actor: nombres.get(h.actorId) ?? null,
        at: h.createdAt,
      })),
    };
  }

  private async tickets(ids: Array<string | null>) {
    const lista = [...new Set(ids.filter((x): x is string => !!x))];
    const filas = lista.length
      ? await this.prisma.ticketRef.findMany({
          where: { ticketId: { in: lista } },
          select: {
            ticketId: true,
            ticketNumero: true,
            pedidoCodigo: true,
            cliente: true,
            campo: true,
            pozo: true,
          },
        })
      : [];
    return new Map(filas.map((f) => [f.ticketId, f]));
  }

  /** Nombre de cada cuenta (las columnas de personas no tienen relación de Prisma: ver schema.prisma). */
  private async nombres(ids: string[]): Promise<Map<string, string>> {
    const filas = await this.prisma.idUsuario.findMany({
      where: { id: { in: [...new Set(ids)] } },
      select: { id: true, nombre: true },
    });
    return new Map(filas.map((f) => [f.id, f.nombre]));
  }
}
