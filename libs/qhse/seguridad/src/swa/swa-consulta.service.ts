import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '../generated/client';
import { EstadoSwa } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';

/** Consecutivo visible de la SWA: SWA-000001. */
export const codigoSwa = (numero: number): string => `SWA-${String(numero).padStart(6, '0')}`;

export interface FiltroSwa {
  estado?: EstadoSwa;
  ticketId?: string;
  q?: string;
}

const CON_TICKET = {
  ticket: {
    select: { ticketNumero: true, pedidoCodigo: true, cliente: true, campo: true, pozo: true },
  },
  tipoPeligro: { select: { id: true, codigo: true, nombre: true } },
  activador: { select: { nombre: true } },
} satisfies Prisma.SwaInclude;

/** Lectura de SWA: bandeja, detalle (con lo que falta notificar y confirmar) y catálogos. */
@Injectable()
export class SwaConsultaService {
  constructor(private readonly prisma: PrismaService) {}

  /** Tipos de peligro activos para el formulario de activación. */
  tiposDePeligro() {
    return this.prisma.swaTipoPeligro.findMany({
      where: { activo: true },
      orderBy: { orden: 'asc' },
      select: { id: true, codigo: true, nombre: true },
    });
  }

  /** Tickets recientes que QHSE conoce, para elegir el servicio detenido al activar (lo usa cualquier trabajador). */
  async ticketsParaActivar() {
    const filas = await this.prisma.ticketRef.findMany({
      orderBy: { updatedAt: 'desc' },
      take: 100,
      select: { ticketId: true, ticketNumero: true, pedidoCodigo: true, cliente: true, pozo: true },
    });
    return filas;
  }

  /** Cuántas SWA sin cerrar tiene un ticket (cada una lo bloquea). */
  async activasDeTicket(
    ticketId: string,
    tx: Pick<PrismaService, 'swa'> = this.prisma,
  ): Promise<number> {
    return tx.swa.count({ where: { ticketId, estado: { not: EstadoSwa.cerrado } } });
  }

  async listar(filtro: FiltroSwa = {}) {
    const q = filtro.q?.trim();
    const filas = await this.prisma.swa.findMany({
      where: {
        ...(filtro.estado ? { estado: filtro.estado } : {}),
        ...(filtro.ticketId ? { ticketId: filtro.ticketId } : {}),
        ...(q
          ? {
              OR: [
                { descripcion: { contains: q, mode: 'insensitive' } },
                { ticket: { pedidoCodigo: { contains: q, mode: 'insensitive' } } },
              ],
            }
          : {}),
      },
      orderBy: { numero: 'desc' },
      include: CON_TICKET,
      take: 300,
    });
    return filas.map((s) => ({
      id: s.id,
      numero: s.numero,
      codigo: codigoSwa(s.numero),
      estado: s.estado,
      tipoPeligro: s.tipoPeligro.nombre,
      descripcion: s.descripcion,
      ticketId: s.ticketId,
      ticketNumero: s.ticket?.ticketNumero ?? null,
      pedidoCodigo: s.ticket?.pedidoCodigo ?? null,
      cliente: s.ticket?.cliente ?? null,
      activadoPor: s.activador.nombre,
      activadoAt: s.activadoAt,
      riesgoReal: s.riesgoReal,
    }));
  }

  async detalle(id: string) {
    const s = await this.prisma.swa.findUnique({
      where: { id },
      include: {
        ...CON_TICKET,
        evaluador: { select: { nombre: true } },
        reanudador: { select: { nombre: true } },
        notificaciones: { include: { notificador: { select: { nombre: true } } } },
        reinicio: { include: { confirmador: { select: { nombre: true } } } },
        historial: {
          include: { actor: { select: { nombre: true } } },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!s) throw new NotFoundException('La SWA no existe');
    const emergencia = await this.prisma.emergencia.findFirst({
      where: { swaId: id },
      select: { id: true, numero: true, estado: true },
    });
    const [cadena, criterios] = await Promise.all([
      this.prisma.swaRolCadena.findMany({
        where: { activo: true },
        orderBy: { orden: 'asc' },
        include: { rol: { select: { codigo: true, nombre: true } } },
      }),
      this.prisma.swaCriterioReinicio.findMany({
        where: { activo: true },
        orderBy: { orden: 'asc' },
      }),
    ]);
    const notificacion = (rolCadenaId: string) =>
      s.notificaciones.find((n) => n.rolCadenaId === rolCadenaId);
    const confirmacion = (criterioId: string) =>
      s.reinicio.find((r) => r.criterioId === criterioId);
    const cadenaVista = cadena.map((c) => {
      const n = notificacion(c.id);
      return {
        rolCadenaId: c.id,
        rolCodigo: c.rol.codigo,
        rol: c.rol.nombre,
        notificadoAt: n?.notificadoAt ?? null,
        notificadoPor: n?.notificador.nombre ?? null,
      };
    });
    const criteriosVista = criterios.map((c) => {
      const r = confirmacion(c.id);
      return {
        criterioId: c.id,
        nombre: c.nombre,
        confirmadoAt: r?.confirmadoAt ?? null,
        confirmadoPor: r?.confirmador.nombre ?? null,
      };
    });
    return {
      id: s.id,
      numero: s.numero,
      codigo: codigoSwa(s.numero),
      estado: s.estado,
      tipoPeligro: s.tipoPeligro,
      descripcion: s.descripcion,
      ubicacion: s.ubicacion,
      ticketId: s.ticketId,
      ticketNumero: s.ticket?.ticketNumero ?? null,
      pedidoCodigo: s.ticket?.pedidoCodigo ?? null,
      cliente: s.ticket?.cliente ?? null,
      campo: s.ticket?.campo ?? null,
      pozo: s.ticket?.pozo ?? null,
      activadoPor: s.activador.nombre,
      activadoAt: s.activadoAt,
      cadena: cadenaVista,
      /** La evaluación queda bloqueada hasta notificar a todos los roles de la cadena. */
      notificacionCompleta: cadenaVista.every((c) => c.notificadoAt !== null),
      riesgoReal: s.riesgoReal,
      evaluacionNota: s.evaluacionNota,
      evaluadoPor: s.evaluador?.nombre ?? null,
      evaluadoAt: s.evaluadoAt,
      criterios: criteriosVista,
      reinicioCompleto: criteriosVista.every((c) => c.confirmadoAt !== null),
      reanudadoPor: s.reanudador?.nombre ?? null,
      reanudadoAt: s.reanudadoAt,
      heroeSeguridad: s.heroeSeguridad,
      /** Emergencia a la que escaló (HSE-MASTER-001); nulo mientras no escale. */
      emergencia: emergencia
        ? {
            id: emergencia.id,
            codigo: `EME-${String(emergencia.numero).padStart(6, '0')}`,
            estado: emergencia.estado,
          }
        : null,
      /** Una SWA que no esté cerrada y aún no tenga emergencia puede escalar. */
      puedeEscalarAEmergencia: s.estado !== 'cerrado' && !emergencia,
      historial: s.historial.map((h) => ({
        estadoAnterior: h.estadoAnterior,
        estadoNuevo: h.estadoNuevo,
        actor: h.actor.nombre,
        at: h.createdAt,
      })),
    };
  }
}
