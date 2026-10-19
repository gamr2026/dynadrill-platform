import { Injectable, NotFoundException } from '@nestjs/common';
import { TipoDocumentoPedido } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';

interface DocumentoVigente {
  id: string;
  archivoId: string;
}

const DIA_MS = 86_400_000;
const aDia = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * Bandeja «Documentos por pedido»: qué tiene y qué le falta a cada pedido que QHSE conoce. Todo se calcula al consultar (nada se guarda):
 * el ART vence a los 15 días de su emisión y avisa 3 días antes; el PT es el de hoy.
 */
@Injectable()
export class DocumentosEstadoService {
  constructor(private readonly prisma: PrismaService) {}

  private async pedidoDe(ticketId: string): Promise<string | null> {
    return (
      (await this.prisma.ticketRef.findUnique({ where: { ticketId }, select: { pedidoId: true } }))
        ?.pedidoId ?? null
    );
  }

  /** El estado de los documentos del pedido de un ticket (lo consulta el equipo de Pumping desde el ticket). */
  async deTicket(ticketId: string) {
    const fila = (await this.pedidos({ ticketId }))[0];
    if (!fila)
      throw new NotFoundException('QHSE no conoce ese ticket (aún no se creó o no se asignó)');
    return fila;
  }

  async pedidos(filtro: { q?: string; limite?: number; ticketId?: string } = {}) {
    const q = filtro.q?.trim();
    const tickets = await this.prisma.ticketRef.findMany({
      where: {
        ...(q ? { pedidoCodigo: { contains: q, mode: 'insensitive' as const } } : {}),
        ...(filtro.ticketId
          ? {
              pedidoId:
                (await this.pedidoDe(filtro.ticketId)) ?? '00000000-0000-0000-0000-000000000000',
            }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
    // los documentos son del pedido (el ticket es opcional): se buscan por `pedido_id`, no por la relación del ticket
    const documentos = await this.prisma.documentoPedido.findMany({
      where: { pedidoId: { in: [...new Set(tickets.map((t) => t.pedidoId))] }, anuladoAt: null },
      select: {
        id: true,
        pedidoId: true,
        tipo: true,
        archivoId: true,
        fecha: true,
        vigenteHasta: true,
        createdAt: true,
      },
    });
    const hoy = new Date();
    const hoyDia = aDia(hoy);

    const porPedido = new Map<string, typeof tickets>();
    for (const t of tickets) porPedido.set(t.pedidoId, [...(porPedido.get(t.pedidoId) ?? []), t]);

    const filas = [...porPedido.entries()].map(([pedidoId, ts]) => {
      const docs = documentos.filter((d) => d.pedidoId === pedidoId);
      const ultimo = (tipo: TipoDocumentoPedido): DocumentoVigente | null => {
        const d = docs
          .filter((x) => x.tipo === tipo)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
        return d ? { id: d.id, archivoId: d.archivoId } : null;
      };
      // el ART con la vigencia más lejana es el que cuenta (puede haber varios por pedido)
      const art = docs
        .filter((x) => x.tipo === TipoDocumentoPedido.art && x.vigenteHasta)
        .sort((a, b) => (b.vigenteHasta as Date).getTime() - (a.vigenteHasta as Date).getTime())[0];
      const venceEnDias = art?.vigenteHasta
        ? Math.round(
            (new Date(`${aDia(art.vigenteHasta)}T00:00:00Z`).getTime() -
              new Date(`${hoyDia}T00:00:00Z`).getTime()) /
              DIA_MS,
          )
        : null;
      const ptHoy = docs.find(
        (x) => x.tipo === TipoDocumentoPedido.pt && x.fecha && aDia(x.fecha) === hoyDia,
      );
      return {
        pedidoId,
        pedidoCodigo: ts[0].pedidoCodigo,
        // copias justificadas de ticket_ref (se toman del ticket más reciente)
        cliente: ts.find((t) => t.cliente)?.cliente ?? null,
        campo: ts.find((t) => t.campo)?.campo ?? null,
        pozo: ts.find((t) => t.pozo)?.pozo ?? null,
        creadoAt: ts[0].createdAt,
        tickets: ts
          .map((t) => ({ ticketId: t.ticketId, numero: t.ticketNumero }))
          .sort((a, b) => (a.numero ?? 0) - (b.numero ?? 0)),
        formatoRecepcion: ultimo(TipoDocumentoPedido.formato_recepcion),
        sfi: ultimo(TipoDocumentoPedido.sfi),
        actaEntrega: ultimo(TipoDocumentoPedido.formato_entrega),
        ptHoy: ptHoy ? { id: ptHoy.id, archivoId: ptHoy.archivoId } : null,
        art: art
          ? {
              id: art.id,
              archivoId: art.archivoId,
              emitidoEl: art.fecha ? aDia(art.fecha) : null,
              vigenteHasta: aDia(art.vigenteHasta as Date),
              venceEnDias,
              vencido: (venceEnDias as number) < 0,
              /** Aviso 3 días antes de vencer. */
              porVencer: (venceEnDias as number) >= 0 && (venceEnDias as number) <= 3,
            }
          : null,
      };
    });
    return filas.slice(0, filtro.limite ?? 200);
  }
}
