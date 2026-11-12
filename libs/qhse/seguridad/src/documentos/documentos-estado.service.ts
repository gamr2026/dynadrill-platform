import { Injectable, NotFoundException } from '@nestjs/common';
import { EstadoRevisionDocumento, TipoDocumentoPedido } from '../generated/client';
import { estadoAnulacion } from '../comun/ticket-activo';
import { PrismaService } from '../prisma/prisma.service';

/** Revisión de QHSE de un documento (la misma en todo lo que lo lista). */
interface RevisionDocumento {
  revisionEstado: 'cargado' | 'aprobado' | 'rechazado';
  revisadoAt: Date | null;
  revisadoPor: string | null;
  motivoRechazo: string | null;
}

interface DocumentoVigente extends RevisionDocumento {
  id: string;
  archivoId: string;
}

/** Último documento rechazado de un tipo que todavía no tiene otro vigente: es lo que se debe volver a cargar. */
interface DocumentoRechazado extends RevisionDocumento {
  id: string;
  tipo: TipoDocumentoPedido;
  archivoId: string;
  fecha: string | null;
}

const DIA_MS = 86_400_000;
const aDia = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * Bandeja «Documentos por pedido»: qué tiene y qué le falta a cada pedido que QHSE conoce. Todo se calcula al consultar (nada se guarda):
 * el ART vence a los 15 días de su emisión y avisa 3 días antes; el PT es el de hoy. Cada fila trae `pedidoAnulado`, `anuladoAt` y
 * `anuladoMotivo` para que la pantalla avise antes de que una carga falle con 409.
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
    // los documentos son del pedido (el ticket es opcional): se buscan por `pedido_id`, no por la relación del ticket.
    // Un documento rechazado está anulado: no cuenta como cargado (el pedido lo tiene por faltante); se trae aparte para mostrar el motivo.
    const todos = await this.prisma.documentoPedido.findMany({
      where: {
        pedidoId: { in: [...new Set(tickets.map((t) => t.pedidoId))] },
        OR: [{ anuladoAt: null }, { revisionEstado: EstadoRevisionDocumento.rechazado }],
      },
      select: {
        id: true,
        pedidoId: true,
        tipo: true,
        archivoId: true,
        fecha: true,
        vigenteHasta: true,
        createdAt: true,
        anuladoAt: true,
        revisionEstado: true,
        revisadoAt: true,
        motivoRechazo: true,
        revisor: { select: { nombre: true } },
      },
    });
    const documentos = todos.filter(
      (d) => d.anuladoAt === null && d.revisionEstado !== EstadoRevisionDocumento.rechazado,
    );
    const revision = (d: (typeof todos)[number]): RevisionDocumento => ({
      revisionEstado: d.revisionEstado,
      revisadoAt: d.revisadoAt,
      revisadoPor: d.revisor?.nombre ?? null,
      motivoRechazo: d.motivoRechazo,
    });
    const hoy = new Date();
    const hoyDia = aDia(hoy);

    const porPedido = new Map<string, typeof tickets>();
    for (const t of tickets) porPedido.set(t.pedidoId, [...(porPedido.get(t.pedidoId) ?? []), t]);

    const filas = [...porPedido.entries()].map(([pedidoId, ts]) => {
      const docs = documentos.filter((d) => d.pedidoId === pedidoId);
      // el último rechazado de cada tipo, solo si ese tipo (y, en el PT, ese día) no tiene ya otro vigente
      const rechazados: DocumentoRechazado[] = [];
      for (const r of todos
        .filter(
          (d) => d.pedidoId === pedidoId && d.revisionEstado === EstadoRevisionDocumento.rechazado,
        )
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())) {
        const dia = r.fecha ? aDia(r.fecha) : null;
        const repuesto = docs.some(
          (x) =>
            x.tipo === r.tipo &&
            (r.tipo !== TipoDocumentoPedido.pt || (x.fecha && aDia(x.fecha) === dia)),
        );
        const yaListado = rechazados.some(
          (x) => x.tipo === r.tipo && (r.tipo !== TipoDocumentoPedido.pt || x.fecha === dia),
        );
        if (!repuesto && !yaListado)
          rechazados.push({
            id: r.id,
            tipo: r.tipo,
            archivoId: r.archivoId,
            fecha: dia,
            ...revision(r),
          });
      }
      const ultimo = (tipo: TipoDocumentoPedido): DocumentoVigente | null => {
        const d = docs
          .filter((x) => x.tipo === tipo)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
        return d ? { id: d.id, archivoId: d.archivoId, ...revision(d) } : null;
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
        // pedido anulado en comercial (se rechaza todo registro nuevo): desde cuándo y por qué. Consultado por ticket, vale el estado de ese ticket.
        ...estadoAnulacion(filtro.ticketId ? ts.filter((t) => t.ticketId === filtro.ticketId) : ts),
        tickets: ts
          .map((t) => ({ ticketId: t.ticketId, numero: t.ticketNumero }))
          .sort((a, b) => (a.numero ?? 0) - (b.numero ?? 0)),
        formatoRecepcion: ultimo(TipoDocumentoPedido.formato_recepcion),
        sfi: ultimo(TipoDocumentoPedido.sfi),
        actaEntrega: ultimo(TipoDocumentoPedido.formato_entrega),
        ptHoy: ptHoy ? { id: ptHoy.id, archivoId: ptHoy.archivoId, ...revision(ptHoy) } : null,
        rechazados,
        art: art
          ? {
              id: art.id,
              archivoId: art.archivoId,
              ...revision(art),
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
