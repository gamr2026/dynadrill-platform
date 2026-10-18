import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '../generated/client';
import { FasePtw } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import { aDia, codigoPtw, requisitosDeGabinete } from './ptw-documentos';

export interface FiltroPtw {
  fase?: FasePtw;
  pedidoId?: string;
  ticketId?: string;
  /** Incluye los anulados (por defecto no). */
  incluirAnulados?: boolean;
  q?: string;
}

const CON_TICKET = {
  ticket: {
    select: {
      ticketNumero: true,
      pedidoCodigo: true,
      cliente: true,
      campo: true,
      pozo: true,
      supervisor: { select: { id: true, nombre: true } },
    },
  },
} satisfies Prisma.PtwInclude;

/** Lectura de PTW: la bandeja y el detalle con lo que falta, las confirmaciones y el historial. */
@Injectable()
export class PtwConsultaService {
  constructor(private readonly prisma: PrismaService) {}

  async listar(filtro: FiltroPtw = {}) {
    const q = filtro.q?.trim();
    const filas = await this.prisma.ptw.findMany({
      where: {
        ...(filtro.fase ? { fase: filtro.fase } : {}),
        ...(filtro.pedidoId ? { pedidoId: filtro.pedidoId } : {}),
        ...(filtro.ticketId ? { ticketId: filtro.ticketId } : {}),
        ...(filtro.incluirAnulados ? {} : { anuladoAt: null }),
        ...(q ? { ticket: { pedidoCodigo: { contains: q, mode: 'insensitive' } } } : {}),
      },
      orderBy: [{ diaOperacion: 'desc' }, { numero: 'desc' }],
      include: CON_TICKET,
      take: 300,
    });
    return filas.map((p) => ({
      id: p.id,
      numero: p.numero,
      codigo: codigoPtw(p.numero),
      ticketId: p.ticketId,
      ticketNumero: p.ticket.ticketNumero,
      pedidoId: p.pedidoId,
      pedidoCodigo: p.ticket.pedidoCodigo,
      cliente: p.ticket.cliente,
      campo: p.ticket.campo,
      pozo: p.ticket.pozo,
      diaOperacion: aDia(p.diaOperacion),
      fase: p.fase,
      anulado: p.anuladoAt !== null,
    }));
  }

  async detalle(id: string) {
    const p = await this.prisma.ptw.findUnique({
      where: { id },
      include: {
        ...CON_TICKET,
        firmas: {
          include: { usuario: { select: { nombre: true } } },
          orderBy: { firmadoAt: 'asc' },
        },
        historial: {
          include: { actor: { select: { nombre: true } } },
          orderBy: { createdAt: 'asc' },
        },
        creador: { select: { nombre: true } },
        anulador: { select: { nombre: true } },
        documentoRecepcion: { select: { id: true, archivoId: true } },
        documentoArt: { select: { id: true, archivoId: true, vigenteHasta: true } },
        documentoPt: { select: { id: true, archivoId: true } },
        documentoSfi: { select: { id: true, archivoId: true } },
      },
    });
    if (!p) throw new NotFoundException('El PTW no existe');

    // En gabinete se calcula qué documento serviría hoy; después de pasar a formalización quedan fijados los que se usaron.
    const requisitos =
      p.fase === FasePtw.gabinete && !p.anuladoAt
        ? await requisitosDeGabinete(this.prisma, p.pedidoId, p.diaOperacion)
        : [
            ['formato_recepcion', 'Formato de recepción', p.documentoRecepcion],
            ['art', 'ART', p.documentoArt],
            ['pt', 'PT', p.documentoPt],
            ['sfi', 'SFI', p.documentoSfi],
          ].map(([tipo, nombre, d]) => {
            const doc = d as { id: string; archivoId: string } | null;
            return {
              tipo,
              nombre,
              documentoId: doc?.id ?? null,
              archivoId: doc?.archivoId ?? null,
              falta: doc ? null : 'No se fijó',
            };
          });

    return {
      id: p.id,
      numero: p.numero,
      codigo: codigoPtw(p.numero),
      ticketId: p.ticketId,
      ticketNumero: p.ticket.ticketNumero,
      pedidoId: p.pedidoId,
      pedidoCodigo: p.ticket.pedidoCodigo,
      cliente: p.ticket.cliente,
      campo: p.ticket.campo,
      pozo: p.ticket.pozo,
      supervisor: p.ticket.supervisor,
      diaOperacion: aDia(p.diaOperacion),
      fase: p.fase,
      requisitos,
      gabineteCompleta: requisitos.every((r) => r.documentoId !== null),
      firmas: p.firmas.map((f) => ({
        tipo: f.tipo,
        nombre: f.usuario.nombre,
        firmadoAt: f.firmadoAt,
      })),
      anulado: p.anuladoAt !== null,
      anuladoAt: p.anuladoAt,
      anuladoPor: p.anulador?.nombre ?? null,
      motivoAnulacion: p.motivoAnulacion,
      abiertoPor: p.creador.nombre,
      createdAt: p.createdAt,
      historial: p.historial.map((h) => ({
        accion: h.accion,
        motivo: h.motivo,
        actor: h.actor.nombre,
        at: h.createdAt,
      })),
    };
  }
}
