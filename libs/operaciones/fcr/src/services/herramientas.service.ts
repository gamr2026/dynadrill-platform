import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { currentTraceparent, type AuthUser } from '@dyn/common';
import { MovimientosService } from '@dyn/inventario';
import { EventBus } from '@dyn/messaging';
import { uuidv7 } from '@dyn/utils';
import { REQ } from '../catalog/sembrar-pasos';
import type { Prisma, TipoEventoHerramienta } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import { estadoDeHerramienta } from './herramienta-estado';
import { PrecargaService } from './precarga.service';
import { RequisitosService } from './requisitos.service';
import {
  ROL_SUPERVISOR,
  esDelEquipo,
  nombreDe,
  TicketsService,
  type TicketParaMover,
} from './tickets.service';

const PASO_PREPARACION = 'preparacion_herramientas';

const HERRAMIENTA_INCLUDE = {
  articulo: { select: { id: true, codigo: true, nombre: true } },
} as const;
type HerramientaConArticulo = Prisma.TicketHerramientaGetPayload<{
  include: typeof HERRAMIENTA_INCLUDE;
}>;

/** Texto de una novedad o de un motivo: obligatorio y sin espacios sobrantes. */
const texto = (v: string | undefined | null, que: string): string => {
  const t = v?.trim();
  if (!t) throw new BadRequestException(`${que} es obligatorio`);
  return t;
};

/**
 * Herramientas del ticket de FCR. Nacen de las líneas del pedido (precarga) o las agrega el Supervisor a mano; el Supervisor las
 * solicita a Bodega, Bodega las prepara y las envía, y el Supervisor las recibe. Cada paso lo marca quien lo hace y queda en la
 * historia de la herramienta. Las herramientas no mueven el kardex (son activos que vuelven; consulta F-10 en las dudas de negocio).
 */
@Injectable()
export class HerramientasService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: EventBus,
    private readonly tickets: TicketsService,
    private readonly precarga: PrecargaService,
    private readonly requisitos: RequisitosService,
    private readonly inventario: MovimientosService,
  ) {}

  // ── lectura ─────────────────────────────────────────────────────────────────────────────────

  /** Las herramientas del ticket con su estado, la movilización (informativa), los avisos de la precarga y si el listado está confirmado. */
  async detalle(ticketId: string) {
    const t = await this.prisma.ticket.findUnique({
      where: { id: ticketId },
      select: { id: true },
    });
    if (!t) throw new NotFoundException('El ticket no existe');
    const [filas, lineas, avisos, confirmado] = await Promise.all([
      this.prisma.ticketHerramienta.findMany({
        where: { ticketId },
        include: HERRAMIENTA_INCLUDE,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
      this.prisma.ticketLinea.findMany({ where: { ticketId }, orderBy: { orden: 'asc' } }),
      this.prisma.ticketAvisoPrecarga.findMany({
        where: { ticketId },
        include: { articulo: { select: { codigo: true, nombre: true } } },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.ticketRequisito.count({
        where: { ticketId, requisitoCodigo: REQ.listadoConfirmado, estado: 'cumplido' },
      }),
    ]);
    // existencia informativa por artículo (no hay reserva de stock)
    const existencias = new Map<string, number>();
    for (const articuloId of new Set(filas.map((f) => f.articuloId))) {
      existencias.set(articuloId, await this.inventario.stockDe(articuloId));
    }
    return {
      listadoConfirmado: confirmado > 0,
      herramientas: filas.map((f) => this.vista(f, existencias.get(f.articuloId) ?? 0)),
      // la movilización solo se muestra: no genera herramientas ni acciones de Bodega
      movilizaciones: lineas
        .filter((l) => l.tipoLinea === 'movilizacion')
        .map((l) => ({
          codigo: l.codigo,
          descripcion: l.descripcion,
          unidad: l.unidad,
          cantidad: Number(l.cantidad),
        })),
      avisosPrecarga: avisos.map((a) => ({
        motivo: a.motivo,
        codigo: a.codigo,
        descripcion: a.descripcion,
        articulo: a.articulo ? `${a.articulo.codigo} · ${a.articulo.nombre}` : null,
      })),
    };
  }

  /** Lo que Bodega tiene por hacer en todos los tickets: solicitado y aún no enviado al Supervisor. */
  async pendientesDeBodega() {
    const filas = await this.prisma.ticketHerramienta.findMany({
      where: {
        solicitadaAt: { not: null },
        enviadaAt: null,
        ticket: { paso: { terminal: false } },
      },
      include: {
        ...HERRAMIENTA_INCLUDE,
        ticket: { include: { cliente: true, pozo: true } },
      },
      orderBy: [{ solicitadaAt: 'asc' }, { id: 'asc' }],
      take: 500,
    });
    return filas.map((f) => ({
      ...this.vista(f, null),
      ticket: {
        id: f.ticketId,
        ticketNumero: f.ticket.ticketNumero,
        pedidoCodigo: f.ticket.pedidoCodigo,
        cliente: nombreDe(f.ticket.cliente),
        pozo: f.ticket.pozo?.nombreCompleto ?? null,
      },
    }));
  }

  /** Herramientas del inventario (artículos activos de categorías con partes) para elegirlas en un kit o agregarlas a un ticket. */
  async disponibles(q: string | undefined) {
    const buscado = q?.trim() ?? '';
    if (buscado.length < 2) throw new BadRequestException('Escriba al menos 2 letras para buscar');
    const filas = await this.prisma.invArticulo.findMany({
      where: {
        activo: true,
        categoria: { llevaPartes: true },
        OR: [
          { codigo: { contains: buscado, mode: 'insensitive' } },
          { nombre: { contains: buscado, mode: 'insensitive' } },
        ],
      },
      orderBy: { nombre: 'asc' },
      take: 30,
      select: { id: true, codigo: true, nombre: true, categoria: { select: { nombre: true } } },
    });
    return filas.map((a) => ({
      id: a.id,
      codigo: a.codigo,
      nombre: a.nombre,
      categoria: a.categoria.nombre,
    }));
  }

  // ── del Supervisor ──────────────────────────────────────────────────────────────────────────

  /** Agrega a mano una herramienta (la que el pedido no contempló, o una dañada a sustituir). */
  async agregar(ticketId: string, articuloId: string, actor: AuthUser) {
    await this.prisma.$transaction(async (tx) => {
      const t = await this.tickets.cargarEnTx(tx, ticketId);
      this.exigirSupervisor(t, actor);
      if (t.pasoCodigo === PASO_PREPARACION) await this.exigirListadoAbierto(tx, ticketId);
      const articulo = await tx.invArticulo.findUnique({
        where: { id: articuloId },
        include: { categoria: true },
      });
      if (!articulo || !articulo.activo || !articulo.categoria.llevaPartes) {
        throw new BadRequestException(
          'El artículo no es una herramienta activa del inventario (categoría con partes)',
        );
      }
      // «tarde»: el resto de la selección ya salió a Bodega
      const yaSolicitadas = await tx.ticketHerramienta.count({
        where: { ticketId, solicitadaAt: { not: null } },
      });
      await tx.ticketHerramienta.create({
        data: {
          id: uuidv7(),
          ticketId,
          articuloId,
          origen: 'manual',
          agregadaTarde: yaSolicitadas > 0,
          createdBy: actor.id,
          updatedBy: actor.id,
        },
      });
      await this.requisitos.sincronizarHerramientasRecibidas(tx, ticketId, actor.id);
    });
    return this.detalle(ticketId);
  }

  /** Quita una herramienta que todavía no se solicitó a Bodega (con historia ya no se puede quitar). */
  async quitar(ticketId: string, herramientaId: string, actor: AuthUser) {
    await this.prisma.$transaction(async (tx) => {
      const t = await this.tickets.cargarEnTx(tx, ticketId);
      this.exigirSupervisor(t, actor);
      if (t.pasoCodigo === PASO_PREPARACION) await this.exigirListadoAbierto(tx, ticketId);
      const h = await this.herramienta(tx, ticketId, herramientaId);
      if (h.solicitadaAt) {
        throw new ConflictException({
          message: 'La herramienta ya se solicitó a Bodega: no se puede quitar',
          code: 'HERRAMIENTA_SOLICITADA',
        });
      }
      await tx.ticketHerramienta.delete({ where: { id: herramientaId } });
      await this.requisitos.sincronizarHerramientasRecibidas(tx, ticketId, actor.id);
    });
    return this.detalle(ticketId);
  }

  /** Solicita a Bodega las herramientas indicadas (o todas las que faltan por solicitar) y le avisa. */
  async solicitar(ticketId: string, ids: string[] | undefined, actor: AuthUser) {
    await this.prisma.$transaction(async (tx) => {
      const t = await this.tickets.cargarEnTx(tx, ticketId);
      this.exigirSupervisor(t, actor);
      this.exigirPaso(t);
      const filas = await tx.ticketHerramienta.findMany({
        where: { ticketId, solicitadaAt: null, ...(ids?.length ? { id: { in: ids } } : {}) },
        include: HERRAMIENTA_INCLUDE,
      });
      if (!filas.length) {
        throw new ConflictException({
          message: 'No hay herramientas por solicitar a Bodega',
          code: 'SIN_HERRAMIENTAS_POR_SOLICITAR',
        });
      }
      if (ids?.length && filas.length !== new Set(ids).size) {
        throw new BadRequestException(
          'Alguna de las herramientas no existe, no es de este ticket o ya se solicitó',
        );
      }
      const ahora = new Date();
      await tx.ticketHerramienta.updateMany({
        where: { id: { in: filas.map((f) => f.id) }, solicitadaAt: null },
        data: { solicitadaAt: ahora, solicitadaPor: actor.id, updatedBy: actor.id },
      });
      await this.registrar(
        tx,
        filas.map((f) => f.id),
        'solicitada',
        actor.id,
      );
      await this.requisitos.sincronizarHerramientasRecibidas(tx, ticketId, actor.id);
      const n = await tx.ticket.findUniqueOrThrow({
        where: { id: ticketId },
        include: { cliente: true, pozo: true },
      });
      await this.bus.publish(
        tx,
        this.bus.create({
          type: 'operaciones.fcr.herramientas_solicitadas',
          subject: { type: 'fcr_ticket', id: ticketId },
          data: {
            ticketId,
            ticketNumero: n.ticketNumero,
            pedidoId: n.pedidoId,
            pedidoCodigo: n.pedidoCodigo,
            cliente: nombreDe(n.cliente),
            pozo: n.pozo?.nombreCompleto ?? null,
            cantidad: filas.length,
            herramientas: [...new Set(filas.map((f) => f.articulo.nombre))].join(', '),
            solicitadoPor: actor.name,
          },
          actor: { userId: actor.id, role: actor.roleCode },
          traceparent: currentTraceparent(),
        }),
      );
    });
    return this.detalle(ticketId);
  }

  /** El Supervisor recibe la herramienta que Bodega le envió; con novedad queda detenida hasta resolverla. */
  async recibir(
    ticketId: string,
    herramientaId: string,
    novedad: string | undefined,
    actor: AuthUser,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const t = await this.tickets.cargarEnTx(tx, ticketId);
      this.exigirSupervisor(t, actor);
      this.exigirPaso(t);
      const h = await this.herramienta(tx, ticketId, herramientaId);
      if (!h.enviadaAt) throw this.conflicto('Bodega todavía no envió esta herramienta');
      if (h.recibidaAt) throw this.conflicto('La herramienta ya está recibida');
      const nov = novedad?.trim();
      if (nov) {
        await tx.ticketHerramienta.update({
          where: { id: h.id },
          data: { recepcionNovedad: nov, updatedBy: actor.id },
        });
        await this.registrar(tx, [h.id], 'recibida_con_novedad', actor.id, nov);
      } else {
        await tx.ticketHerramienta.update({
          where: { id: h.id },
          data: {
            recibidaAt: new Date(),
            recibidaPor: actor.id,
            recepcionNovedad: null,
            updatedBy: actor.id,
          },
        });
        await this.registrar(tx, [h.id], 'recibida', actor.id);
      }
      await this.requisitos.sincronizarHerramientasRecibidas(tx, ticketId, actor.id);
    });
    return this.detalle(ticketId);
  }

  /** Deshace la recepción de una herramienta (solo mientras no se haya devuelto ni dado por faltante). */
  async corregirRecepcion(ticketId: string, herramientaId: string, actor: AuthUser) {
    await this.prisma.$transaction(async (tx) => {
      const t = await this.tickets.cargarEnTx(tx, ticketId);
      this.exigirSupervisor(t, actor);
      this.exigirPaso(t);
      const h = await this.herramienta(tx, ticketId, herramientaId);
      if (h.devueltaAt || h.faltanteAt)
        throw this.conflicto('La herramienta ya tiene su retorno registrado');
      if (!h.recibidaAt && !h.recepcionNovedad)
        throw this.conflicto('La herramienta no tiene una recepción que deshacer');
      await tx.ticketHerramienta.update({
        where: { id: h.id },
        data: { recibidaAt: null, recibidaPor: null, recepcionNovedad: null, updatedBy: actor.id },
      });
      await this.registrar(tx, [h.id], 'recepcion_corregida', actor.id);
      await this.requisitos.sincronizarHerramientasRecibidas(tx, ticketId, actor.id);
    });
    return this.detalle(ticketId);
  }

  /** Confirma (o deshace la confirmación de) que el listado de herramientas está completo. Confirmado, no se agrega ni se quita. */
  async confirmarListado(ticketId: string, confirmado: boolean, actor: AuthUser) {
    await this.prisma.$transaction(async (tx) => {
      const t = await this.tickets.cargarEnTx(tx, ticketId);
      this.exigirSupervisor(t, actor);
      this.exigirPaso(t);
      const clave = { ticketId, codigo: REQ.listadoConfirmado };
      if (confirmado) await this.requisitos.marcar(tx, clave, 'sistema', actor.id);
      else await this.requisitos.reabrir(tx, clave);
    });
    return this.detalle(ticketId);
  }

  /** «Recargar desde el pedido»: vuelve a armar la precarga con las líneas y el kit vigentes (ver `PrecargaService.armar`). */
  async recargar(ticketId: string, actor: AuthUser) {
    await this.prisma.$transaction(async (tx) => {
      const t = await this.tickets.cargarEnTx(tx, ticketId);
      this.exigirSupervisor(t, actor);
      this.exigirPaso(t);
      await this.exigirListadoAbierto(tx, ticketId);
      await this.precarga.armar(tx, ticketId, actor.id);
      await this.requisitos.sincronizarHerramientasRecibidas(tx, ticketId, actor.id);
    });
    return this.detalle(ticketId);
  }

  // ── de Bodega ───────────────────────────────────────────────────────────────────────────────

  /** Bodega marca la herramienta como preparada; con novedad queda registrada y la herramienta no avanza. */
  async preparar(
    ticketId: string,
    herramientaId: string,
    novedad: string | undefined,
    actor: AuthUser,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const t = await this.tickets.cargarEnTx(tx, ticketId);
      this.exigirNoTerminal(t);
      const h = await this.herramienta(tx, ticketId, herramientaId);
      if (!h.solicitadaAt)
        throw this.conflicto('El Supervisor todavía no solicitó esta herramienta');
      if (h.preparadaAt) throw this.conflicto('La herramienta ya está preparada');
      const nov = novedad?.trim();
      if (nov) {
        await tx.ticketHerramienta.update({
          where: { id: h.id },
          data: { bodegaNovedad: nov, updatedBy: actor.id },
        });
        await this.registrar(tx, [h.id], 'preparada_con_novedad', actor.id, nov);
      } else {
        await tx.ticketHerramienta.update({
          where: { id: h.id },
          data: {
            preparadaAt: new Date(),
            preparadaPor: actor.id,
            bodegaNovedad: null,
            updatedBy: actor.id,
          },
        });
        await this.registrar(tx, [h.id], 'preparada', actor.id);
      }
    });
    return this.detalle(ticketId);
  }

  /** Deshace la preparación (solo mientras Bodega no la haya enviado al Supervisor). */
  async corregirPreparacion(ticketId: string, herramientaId: string, actor: AuthUser) {
    await this.prisma.$transaction(async (tx) => {
      const t = await this.tickets.cargarEnTx(tx, ticketId);
      this.exigirNoTerminal(t);
      const h = await this.herramienta(tx, ticketId, herramientaId);
      if (h.enviadaAt) throw this.conflicto('La herramienta ya se envió al Supervisor');
      if (!h.preparadaAt && !h.bodegaNovedad)
        throw this.conflicto('La herramienta no tiene una preparación que deshacer');
      await tx.ticketHerramienta.update({
        where: { id: h.id },
        data: { preparadaAt: null, preparadaPor: null, bodegaNovedad: null, updatedBy: actor.id },
      });
      await this.registrar(tx, [h.id], 'preparacion_corregida', actor.id);
    });
    return this.detalle(ticketId);
  }

  /** Bodega envía al Supervisor lo que ya preparó sin novedad. */
  async enviar(ticketId: string, herramientaId: string, actor: AuthUser) {
    await this.prisma.$transaction(async (tx) => {
      const t = await this.tickets.cargarEnTx(tx, ticketId);
      this.exigirNoTerminal(t);
      const h = await this.herramienta(tx, ticketId, herramientaId);
      if (!h.preparadaAt) throw this.conflicto('La herramienta todavía no está preparada');
      if (h.enviadaAt) throw this.conflicto('La herramienta ya se envió');
      await tx.ticketHerramienta.update({
        where: { id: h.id },
        data: { enviadaAt: new Date(), enviadaPor: actor.id, updatedBy: actor.id },
      });
      await this.registrar(tx, [h.id], 'enviada', actor.id);
    });
    return this.detalle(ticketId);
  }

  // ── piezas internas ─────────────────────────────────────────────────────────────────────────

  /** El Supervisor del ticket (o Superadmin), mientras el ticket esté en un paso que atiende el Supervisor. */
  private exigirSupervisor(t: TicketParaMover, actor: AuthUser): void {
    this.exigirNoTerminal(t);
    if (actor.roleCode === 'superadmin') return;
    if (actor.roleCode !== ROL_SUPERVISOR) {
      throw new ForbiddenException('Esta acción es del Supervisor del ticket');
    }
    if (!t.paso.roles.some((r) => r.rolCodigo === ROL_SUPERVISOR)) {
      throw new ForbiddenException(
        `En el paso "${t.paso.nombre}" el Supervisor no modifica las herramientas`,
      );
    }
    if (t.paso.requiereEquipo && !esDelEquipo(t, actor.id)) {
      throw new ForbiddenException('Solo el equipo asignado a este ticket puede hacerlo');
    }
  }

  private exigirNoTerminal(t: TicketParaMover): void {
    if (t.paso.terminal) throw this.conflicto('El ticket está cerrado: solo se puede consultar');
  }

  /** Solicitar, recibir, confirmar y recargar son de la preparación de herramientas. */
  private exigirPaso(t: TicketParaMover): void {
    if (t.pasoCodigo !== PASO_PREPARACION) {
      throw new ConflictException('Esto se hace en el paso «Preparación de herramientas»');
    }
  }

  /** Confirmado el listado, no se agrega ni se quita nada hasta deshacer la confirmación. */
  private async exigirListadoAbierto(
    tx: Prisma.TransactionClient,
    ticketId: string,
  ): Promise<void> {
    const confirmado = await tx.ticketRequisito.count({
      where: { ticketId, requisitoCodigo: REQ.listadoConfirmado, estado: 'cumplido' },
    });
    if (confirmado) {
      throw new ConflictException({
        message: 'El listado está confirmado: deshaga la confirmación para cambiarlo',
        code: 'LISTADO_CONFIRMADO',
      });
    }
  }

  private async herramienta(tx: Prisma.TransactionClient, ticketId: string, id: string) {
    const h = await tx.ticketHerramienta.findFirst({ where: { id, ticketId } });
    if (!h) throw new NotFoundException('La herramienta no existe en este ticket');
    return h;
  }

  private conflicto(mensaje: string): ConflictException {
    return new ConflictException(mensaje);
  }

  private async registrar(
    tx: Prisma.TransactionClient,
    ids: string[],
    tipo: TipoEventoHerramienta,
    actorId: string,
    detalle?: string,
  ): Promise<void> {
    await tx.ticketHerramientaEvento.createMany({
      data: ids.map((herramientaId) => ({
        id: uuidv7(),
        herramientaId,
        tipo,
        actorId,
        detalle: detalle ? texto(detalle, 'El detalle') : null,
      })),
    });
  }

  private vista(f: HerramientaConArticulo, existencia: number | null) {
    return {
      id: f.id,
      articuloId: f.articuloId,
      codigo: f.articulo.codigo,
      nombre: f.articulo.nombre,
      origen: f.origen,
      codigoPedido: f.codigoPedido,
      agregadaTarde: f.agregadaTarde,
      numeroSerie: f.numeroSerie,
      estado: estadoDeHerramienta(f),
      existencia,
      solicitadaAt: f.solicitadaAt,
      preparadaAt: f.preparadaAt,
      bodegaNovedad: f.bodegaNovedad,
      enviadaAt: f.enviadaAt,
      recibidaAt: f.recibidaAt,
      recepcionNovedad: f.recepcionNovedad,
      devueltaAt: f.devueltaAt,
      faltanteAt: f.faltanteAt,
      faltanteMotivo: f.faltanteMotivo,
    };
  }
}
