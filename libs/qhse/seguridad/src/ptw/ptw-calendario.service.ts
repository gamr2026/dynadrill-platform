import { BadRequestException, Injectable } from '@nestjs/common';
import { aFecha, hoyEcuador, masDias } from '../comun/fechas';
import { TipoDocumentoPedido } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';

/** Un calendario muestra como mucho este rango: más días no caben en pantalla y son miles de filas. */
export const MAX_DIAS_CALENDARIO = 31;
const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const dia = (d: Date) => d.toISOString().slice(0, 10);

export interface DiaDeCobertura {
  fecha: string;
  /** El ticket tiene servicio ese día (solo esos días exigen PTW, PT y ART). */
  servicio: boolean;
  /** Fase del PTW vigente de ese día, o `sin` si no hay (ni abierto). */
  ptw: string;
  /** Hay un PT cargado de ese día. */
  pt: boolean;
  /** Hay un ART vigente que cubre ese día. */
  art: boolean;
}

export interface TicketCobertura {
  ticketId: string;
  ticketNumero: number | null;
  pedidoCodigo: string;
  cliente: string | null;
  campo: string | null;
  pozo: string | null;
  dias: DiaDeCobertura[];
}

export interface CalendarioCobertura {
  desde: string;
  hasta: string;
  dias: string[];
  tickets: TicketCobertura[];
}

/**
 * Calendario de cobertura: por ticket y por día de servicio, si el día tiene su PTW (y en qué fase), su PT y un ART vigente. El PTW y el PT son de
 * un solo día; el ART se carga por rango (hasta 15 días) y cubre todos los de su rango. Sirve para ver de un vistazo qué días van a quedar bloqueados
 * en Pumping por falta de algo de QHSE.
 */
@Injectable()
export class PtwCalendarioService {
  constructor(private readonly prisma: PrismaService) {}

  async cobertura(desde?: string, hasta?: string): Promise<CalendarioCobertura> {
    const ini = desde ?? hoyEcuador();
    const fin = hasta ?? masDias(ini, 6);
    if (![ini, fin].every((f) => FECHA.test(f) && !Number.isNaN(Date.parse(`${f}T00:00:00Z`))))
      throw new BadRequestException('Las fechas deben tener el formato AAAA-MM-DD');
    if (fin < ini)
      throw new BadRequestException('La fecha final no puede ser anterior a la inicial');
    const dias: string[] = [];
    for (let f = ini; f <= fin && dias.length <= MAX_DIAS_CALENDARIO; f = masDias(f, 1))
      dias.push(f);
    if (dias.length > MAX_DIAS_CALENDARIO)
      throw new BadRequestException(`El calendario muestra hasta ${MAX_DIAS_CALENDARIO} días`);

    const enServicio = await this.prisma.ticketDiaServicio.findMany({
      where: { fecha: { gte: aFecha(ini), lte: aFecha(fin) } },
      select: {
        fecha: true,
        ticket: {
          select: {
            ticketId: true,
            ticketNumero: true,
            pedidoId: true,
            pedidoCodigo: true,
            cliente: true,
            campo: true,
            pozo: true,
          },
        },
      },
    });
    const pedidos = [...new Set(enServicio.map((e) => e.ticket.pedidoId))];
    const ptws = await this.prisma.ptw.findMany({
      where: {
        pedidoId: { in: pedidos },
        diaOperacion: { gte: aFecha(ini), lte: aFecha(fin) },
        anuladoAt: null,
      },
      select: { pedidoId: true, diaOperacion: true, fase: true },
    });
    const documentos = await this.prisma.documentoPedido.findMany({
      where: {
        pedidoId: { in: pedidos },
        anuladoAt: null,
        tipo: { in: [TipoDocumentoPedido.pt, TipoDocumentoPedido.art] },
        fecha: { lte: aFecha(fin) },
        OR: [{ vigenteHasta: null }, { vigenteHasta: { gte: aFecha(ini) } }],
      },
      select: { pedidoId: true, tipo: true, fecha: true, vigenteHasta: true },
    });

    const faseDe = new Map(ptws.map((p) => [`${p.pedidoId}|${dia(p.diaOperacion)}`, p.fase]));
    const hayPt = new Set(
      documentos
        .filter((d) => d.tipo === TipoDocumentoPedido.pt && d.fecha)
        .map((d) => `${d.pedidoId}|${dia(d.fecha as Date)}`),
    );
    const arts = documentos.filter((d) => d.tipo === TipoDocumentoPedido.art && d.fecha);
    const cubreArt = (pedidoId: string, f: string) =>
      arts.some(
        (a) =>
          a.pedidoId === pedidoId &&
          dia(a.fecha as Date) <= f &&
          (!a.vigenteHasta || f <= dia(a.vigenteHasta)),
      );

    const porTicket = new Map<string, TicketCobertura & { servicios: Set<string> }>();
    for (const e of enServicio) {
      const t = e.ticket;
      const fila = porTicket.get(t.ticketId) ?? {
        ticketId: t.ticketId,
        ticketNumero: t.ticketNumero,
        pedidoCodigo: t.pedidoCodigo,
        cliente: t.cliente,
        campo: t.campo,
        pozo: t.pozo,
        dias: [],
        servicios: new Set<string>(),
      };
      fila.servicios.add(dia(e.fecha));
      porTicket.set(t.ticketId, fila);
    }
    const pedidoDe = new Map(enServicio.map((e) => [e.ticket.ticketId, e.ticket.pedidoId]));
    const tickets = [...porTicket.values()]
      .map(({ servicios, ...t }) => ({
        ...t,
        dias: dias.map((f): DiaDeCobertura => {
          const pedidoId = pedidoDe.get(t.ticketId) as string;
          const servicio = servicios.has(f);
          return {
            fecha: f,
            servicio,
            ptw: faseDe.get(`${pedidoId}|${f}`) ?? 'sin',
            pt: hayPt.has(`${pedidoId}|${f}`),
            art: cubreArt(pedidoId, f),
          };
        }),
      }))
      .sort((a, b) => (a.ticketNumero ?? 0) - (b.ticketNumero ?? 0));
    return { desde: ini, hasta: fin, dias, tickets };
  }
}
