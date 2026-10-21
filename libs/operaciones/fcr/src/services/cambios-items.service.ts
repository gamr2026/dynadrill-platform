import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { currentTraceparent, type AuthUser } from '@dyn/common';
import { EventBus } from '@dyn/messaging';
import { uuidv7 } from '@dyn/utils';
import type { Prisma, TipoLinea } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import { nombreDe } from './tickets.service';

export const EVENTO_CAMBIO_APROBADO = 'operaciones.fcr.cambio_items_aprobado';

export interface ItemPropuesto {
  listaPreciosItemId: string;
  codigo: string;
  descripcion: string;
  unidad: string;
  cantidad: number;
  descuentoPct?: number | null;
  tipoLinea: TipoLinea;
}

const INCLUIR = {
  items: { orderBy: { orden: 'asc' } },
  solicitante: { select: { id: true, nombre: true } },
  revisor: { select: { id: true, nombre: true } },
} satisfies Prisma.SolicitudCambioItemsInclude;

type SolicitudConDatos = Prisma.SolicitudCambioItemsGetPayload<{ include: typeof INCLUIR }>;

/**
 * Solicitudes de cambio de ítems del pedido de FCR (contrato 4.13, igual que Pumping): el Operador del equipo propone la lista de ítems que debe quedar en el
 * pedido y el Supervisor del ticket la aprueba o la rechaza. Al aprobar se publica el evento y Comercial aplica el cambio; su
 * respuesta (aplicado o por qué no) se guarda en \`aplicacion\`. Los precios no pasan por aquí: los pone Comercial con su lista.
 */
@Injectable()
export class CambiosItemsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: EventBus,
  ) {}

  async proponer(ticketId: string, motivo: string, items: ItemPropuesto[], actor: AuthUser) {
    const texto = motivo?.trim();
    if (!texto) throw new BadRequestException('Indique el motivo del cambio');
    this.validarItems(items);
    const id = await this.prisma.$transaction(async (tx) => {
      const t = await tx.ticket.findUnique({
        where: { id: ticketId },
        select: { id: true, pasoCodigo: true, personas: { select: { usuarioId: true } } },
      });
      if (!t) throw new NotFoundException('El ticket no existe');
      if (t.personas.length === 0) {
        throw new ConflictException('El ticket todavía no tiene equipo asignado');
      }
      if (t.pasoCodigo === 'cierre') {
        throw new ConflictException('El ticket ya está cerrado: no admite cambios de ítems');
      }
      if (actor.roleCode !== 'superadmin' && !t.personas.some((p) => p.usuarioId === actor.id)) {
        throw new ForbiddenException(
          'Solo el equipo asignado a este ticket puede proponer cambios',
        );
      }
      const pendiente = await tx.solicitudCambioItems.findFirst({
        where: { ticketId, estado: 'pendiente' },
        select: { id: true },
      });
      if (pendiente) {
        throw new ConflictException({
          message: 'Ya hay una solicitud de cambio pendiente de aprobación para este ticket',
          code: 'SOLICITUD_PENDIENTE',
        });
      }
      const nuevo = uuidv7();
      await tx.solicitudCambioItems.create({
        data: { id: nuevo, ticketId, motivo: texto, solicitadoPor: actor.id },
      });
      await tx.solicitudCambioItem.createMany({
        data: items.map((i, k) => ({
          id: uuidv7(),
          solicitudId: nuevo,
          orden: k + 1,
          listaPreciosItemId: i.listaPreciosItemId,
          codigo: i.codigo.trim(),
          descripcion: i.descripcion.trim(),
          unidad: i.unidad.trim(),
          cantidad: i.cantidad,
          descuentoPct: i.descuentoPct ?? null,
          tipoLinea: i.tipoLinea,
        })),
      });
      return nuevo;
    });
    return this.obtener(id);
  }

  /** Las solicitudes de un ticket, la más reciente primero. */
  async listar(ticketId: string) {
    const t = await this.prisma.ticket.findUnique({
      where: { id: ticketId },
      select: { id: true },
    });
    if (!t) throw new NotFoundException('El ticket no existe');
    const filas = await this.prisma.solicitudCambioItems.findMany({
      where: { ticketId },
      include: INCLUIR,
      orderBy: { solicitadoAt: 'desc' },
    });
    return filas.map((s) => this.vista(s));
  }

  /** Bandeja de Aprobaciones: las pendientes de los tickets que supervisa quien consulta (Superadmin ve todas). */
  async pendientes(actor: AuthUser) {
    const filas = await this.prisma.solicitudCambioItems.findMany({
      where: {
        estado: 'pendiente',
        ...(actor.roleCode === 'superadmin'
          ? {}
          : { ticket: { personas: { some: { usuarioId: actor.id, rol: 'supervisor' } } } }),
      },
      include: {
        ...INCLUIR,
        ticket: {
          select: {
            id: true,
            ticketNumero: true,
            pedidoId: true,
            pedidoCodigo: true,
            cliente: true,
          },
        },
      },
      orderBy: { solicitadoAt: 'asc' },
    });
    return filas.map((s) => ({
      ...this.vista(s),
      ticket: {
        id: s.ticket.id,
        numero: s.ticket.ticketNumero,
        pedidoId: s.ticket.pedidoId,
        pedidoCodigo: s.ticket.pedidoCodigo,
        cliente: nombreDe(s.ticket.cliente),
      },
    }));
  }

  async aprobar(id: string, actor: AuthUser) {
    await this.prisma.$transaction(async (tx) => {
      const s = await this.cargarPendiente(tx, id, actor);
      await tx.solicitudCambioItems.update({
        where: { id },
        data: {
          estado: 'aprobada',
          revisadoPor: actor.id,
          revisadoAt: new Date(),
          aplicacion: 'pendiente',
        },
      });
      await this.bus.publish(
        tx,
        this.bus.create({
          type: EVENTO_CAMBIO_APROBADO,
          subject: { type: 'fcr_ticket', id: s.ticketId },
          data: {
            solicitudId: id,
            ticketId: s.ticketId,
            pedidoId: s.ticket.pedidoId,
            motivo: s.motivo,
            items: s.items.map((i) => ({
              listaPreciosItemId: i.listaPreciosItemId,
              cantidad: Number(i.cantidad),
              descuentoPct: i.descuentoPct === null ? undefined : Number(i.descuentoPct),
              tipoLinea: i.tipoLinea,
            })),
          },
          actor: { userId: actor.id, role: actor.roleCode },
          traceparent: currentTraceparent(),
        }),
      );
    });
    return this.obtener(id);
  }

  async rechazar(id: string, motivo: string | null, actor: AuthUser) {
    await this.prisma.$transaction(async (tx) => {
      await this.cargarPendiente(tx, id, actor);
      await tx.solicitudCambioItems.update({
        where: { id },
        data: {
          estado: 'rechazada',
          revisadoPor: actor.id,
          revisadoAt: new Date(),
          motivoRechazo: motivo?.trim() || null,
        },
      });
    });
    return this.obtener(id);
  }

  /** Respuesta de Comercial (evento): el cambio quedó aplicado, o por qué no se pudo. Idempotente. */
  async registrarResultado(
    tx: Prisma.TransactionClient,
    solicitudId: string,
    aplicado: boolean,
    motivo: string | null,
  ): Promise<void> {
    await tx.solicitudCambioItems.updateMany({
      where: { id: solicitudId, estado: 'aprobada', aplicacion: 'pendiente' },
      data: {
        aplicacion: aplicado ? 'aplicada' : 'no_aplicada',
        aplicacionMotivo: aplicado ? null : (motivo ?? 'Comercial no pudo aplicar el cambio'),
        aplicadaAt: new Date(),
      },
    });
  }

  // ── piezas internas ─────────────────────────────────────────────────────────────────────────────

  private async obtener(id: string) {
    const s = await this.prisma.solicitudCambioItems.findUnique({
      where: { id },
      include: INCLUIR,
    });
    if (!s) throw new NotFoundException('La solicitud no existe');
    return this.vista(s);
  }

  /** La solicitud existe, sigue pendiente y quien revisa es el Supervisor del ticket (o Superadmin). */
  private async cargarPendiente(tx: Prisma.TransactionClient, id: string, actor: AuthUser) {
    const s = await tx.solicitudCambioItems.findUnique({
      where: { id },
      include: {
        items: { orderBy: { orden: 'asc' } },
        ticket: {
          select: { pedidoId: true, personas: { select: { usuarioId: true, rol: true } } },
        },
      },
    });
    if (!s) throw new NotFoundException('La solicitud no existe');
    if (s.estado !== 'pendiente') {
      throw new ConflictException({
        message: 'Esta solicitud ya fue revisada',
        code: 'SOLICITUD_REVISADA',
      });
    }
    const esSupervisor = s.ticket.personas.some(
      (p) => p.rol === 'supervisor' && p.usuarioId === actor.id,
    );
    if (!esSupervisor && actor.roleCode !== 'superadmin') {
      throw new ForbiddenException(
        'Solo el Supervisor de este ticket puede aprobar o rechazar el cambio',
      );
    }
    return s;
  }

  private validarItems(items: ItemPropuesto[]): void {
    if (!items.length) throw new BadRequestException('Proponga al menos un ítem');
    const vistos = new Set<string>();
    for (const [k, i] of items.entries()) {
      const n = k + 1;
      if (vistos.has(i.listaPreciosItemId)) {
        throw new BadRequestException(
          `El ítem ${n} está repetido: sume las cantidades en un solo renglón`,
        );
      }
      vistos.add(i.listaPreciosItemId);
      if (!(i.cantidad > 0))
        throw new BadRequestException(`La cantidad del ítem ${n} debe ser mayor que cero`);
      if (i.descuentoPct != null && (i.descuentoPct < 0 || i.descuentoPct > 100)) {
        throw new BadRequestException(`El descuento del ítem ${n} va entre 0 y 100`);
      }
      if (!i.codigo?.trim() || !i.descripcion?.trim() || !i.unidad?.trim()) {
        throw new BadRequestException(`Faltan datos del ítem ${n}`);
      }
    }
  }

  private vista(s: SolicitudConDatos) {
    return {
      id: s.id,
      ticketId: s.ticketId,
      estado: s.estado,
      motivo: s.motivo,
      solicitadoPor: s.solicitante,
      solicitadoAt: s.solicitadoAt,
      revisadoPor: s.revisor,
      revisadoAt: s.revisadoAt,
      motivoRechazo: s.motivoRechazo,
      aplicacion: s.aplicacion,
      aplicacionMotivo: s.aplicacionMotivo,
      aplicadaAt: s.aplicadaAt,
      items: s.items.map((i) => ({
        listaPreciosItemId: i.listaPreciosItemId,
        codigo: i.codigo,
        descripcion: i.descripcion,
        unidad: i.unidad,
        cantidad: Number(i.cantidad),
        descuentoPct: i.descuentoPct === null ? null : Number(i.descuentoPct),
        tipoLinea: i.tipoLinea,
      })),
    };
  }
}
