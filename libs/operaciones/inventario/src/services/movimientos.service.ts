import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { currentTraceparent, type AuthUser } from '@dyn/common';
import { EventBus } from '@dyn/messaging';
import { uuidv7 } from '@dyn/utils';
import type { ListarMovimientosDto, RegistrarMovimientoDto } from '../dto/inventario.dto';
import { Prisma, type OrigenMovimiento } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  balanceDeTicket,
  bloquearArticulo,
  registrarEnKardex,
  saldosPorBodega,
  validarCantidad,
  type BalanceTicketArticulo,
  type EntradaKardex,
} from './kardex';

/** Quién registra: basta el id y el rol (así lo pueden llamar otros módulos del contenedor con su propio actor). */
export type ActorInventario = Pick<AuthUser, 'id' | 'roleCode'>;

/** Salida o devolución de un artículo de/hacia un ticket de Pumping. */
export interface MovimientoDeTicket {
  ticketPumpingId: string;
  articuloId: string;
  bodegaId: string;
  cantidad: number | string;
  observacion?: string | null;
}

export interface ConsumoDeTicket {
  ticketPumpingId: string;
  articuloId: string;
  cantidad: number | string;
  observacion?: string | null;
}

export interface MovimientoDeDespacho {
  despachoId: string;
  articuloId: string;
  bodegaId: string;
  cantidad: number | string;
  observacion?: string | null;
}

export interface EntradaManual {
  articuloId: string;
  bodegaId: string;
  /** Un motivo de entrada (compra, ajuste sobrante…). */
  motivoId: string;
  cantidad: number | string;
  fecha?: Date;
  observacion?: string | null;
}

const INCLUIR = {
  bodega: { select: { id: true, nombre: true } },
  motivo: { select: { id: true, nombre: true } },
  responsable: { select: { id: true, nombre: true } },
} satisfies Prisma.MovimientoInclude;

type MovimientoConNombres = Prisma.MovimientoGetPayload<{ include: typeof INCLUIR }>;

/** Renglón del kardex tal como lo ve la pantalla: nombres por JOIN y números. */
export function vistaMovimiento(m: MovimientoConNombres) {
  return {
    id: m.id,
    secuencia: Number(m.secuencia),
    articuloId: m.articuloId,
    bodega: m.bodega,
    tipo: m.tipo,
    origen: m.origen,
    motivo: m.motivo,
    cantidad: Number(m.cantidad),
    saldoResultante: Number(m.saldoResultante),
    fecha: m.fecha.toISOString(),
    observacion: m.observacion,
    responsable: m.responsable,
    ticketId: m.ticketPumpingId,
    despachoId: m.despachoId,
  };
}

export const INCLUIR_MOVIMIENTO = INCLUIR;

/** Un hecho de negocio = un evento: las salidas y devoluciones de ticket tienen el suyo; el resto, el genérico. */
const EVENTO_POR_ORIGEN: Partial<Record<OrigenMovimiento, string>> = {
  salida_ticket: 'operaciones.inventario.salida_registrada',
  devolucion_ticket: 'operaciones.inventario.devolucion_registrada',
};
const EVENTO_GENERICO = 'operaciones.inventario.movimiento_registrado';

/**
 * Kardex de Inventario. Es la puerta de entrada de los demás módulos del contenedor: cada método recibe la transacción de quien
 * llama (una sola `tx`), de modo que el movimiento, el evento y el cambio del otro módulo se confirman o se revierten juntos.
 */
@Injectable()
export class MovimientosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: EventBus,
  ) {}

  /** Registra el movimiento y publica su evento, dentro de la transacción recibida. */
  async registrar(
    tx: Prisma.TransactionClient,
    entrada: Omit<EntradaKardex, 'responsableId'>,
    actor: ActorInventario,
  ) {
    const m = await registrarEnKardex(tx, { ...entrada, responsableId: actor.id });
    const articulo = await tx.articulo.findUniqueOrThrow({
      where: { id: m.articuloId },
      select: { codigo: true },
    });
    await this.bus.publish(
      tx,
      this.bus.create({
        type: EVENTO_POR_ORIGEN[m.origen] ?? EVENTO_GENERICO,
        subject: { type: 'inventario_articulo', id: m.articuloId },
        data: {
          movimientoId: m.id,
          articuloId: m.articuloId,
          articuloCodigo: articulo.codigo,
          bodegaId: m.bodegaId,
          tipo: m.tipo,
          origen: m.origen,
          cantidad: Number(m.cantidad),
          saldoResultante: Number(m.saldoResultante),
          ticketId: m.ticketPumpingId,
          despachoId: m.despachoId,
        },
        actor: { userId: actor.id, role: actor.roleCode },
        traceparent: currentTraceparent(),
      }),
    );
    return m;
  }

  // --- API para los demás módulos del contenedor (Pumping, FCR) ---------------------------------------------

  /** Entrada de bodega con un motivo manual de entrada (compra, ajuste sobrante). */
  async registrarEntrada(tx: Prisma.TransactionClient, e: EntradaManual, actor: ActorInventario) {
    await this.exigirMotivoManual(tx, e.motivoId, 'entrada');
    return this.registrar(tx, e, actor);
  }

  /** Salida de bodega con un motivo manual de salida (faltante, baja, devolución a proveedor). */
  async registrarSalidaManual(
    tx: Prisma.TransactionClient,
    e: EntradaManual,
    actor: ActorInventario,
  ) {
    await this.exigirMotivoManual(tx, e.motivoId, 'salida');
    return this.registrar(tx, e, actor);
  }

  /** Salida de un químico o insumo para un ticket de Pumping: sale de la bodega y queda a cargo del ticket. */
  async registrarSalida(
    tx: Prisma.TransactionClient,
    e: MovimientoDeTicket,
    actor: ActorInventario,
  ) {
    return this.registrar(tx, { ...e, motivoId: await this.motivoDe(tx, 'salida_ticket') }, actor);
  }

  /** Devolución a bodega de lo que el ticket no usó. No puede devolver más de lo que sigue a cargo del ticket. */
  async registrarDevolucion(
    tx: Prisma.TransactionClient,
    e: MovimientoDeTicket,
    actor: ActorInventario,
  ) {
    const cantidad = new Prisma.Decimal(e.cantidad);
    validarCantidad(cantidad);
    await bloquearArticulo(tx, e.articuloId);
    await this.exigirPendiente(tx, e.ticketPumpingId, e.articuloId, cantidad, 'devolver');
    return this.registrar(
      tx,
      { ...e, motivoId: await this.motivoDe(tx, 'devolucion_ticket') },
      actor,
    );
  }

  /**
   * Consumo real en la ejecución: no mueve stock (lo que salió ya salió; lo que no se use se devuelve), solo deja constancia
   * de cuánto se usó. No puede superar lo que sigue a cargo del ticket.
   */
  async registrarConsumo(tx: Prisma.TransactionClient, e: ConsumoDeTicket, actor: ActorInventario) {
    const cantidad = new Prisma.Decimal(e.cantidad);
    validarCantidad(cantidad);
    await bloquearArticulo(tx, e.articuloId);
    if (
      !(await tx.pumpTicket.findUnique({ where: { id: e.ticketPumpingId }, select: { id: true } }))
    ) {
      throw new ConflictException({ message: 'El ticket no existe', code: 'TICKET_INVALIDO' });
    }
    await this.exigirPendiente(tx, e.ticketPumpingId, e.articuloId, cantidad, 'consumir');
    const c = await tx.consumoTicket.create({
      data: {
        id: uuidv7(),
        ticketPumpingId: e.ticketPumpingId,
        articuloId: e.articuloId,
        cantidad,
        fecha: new Date(),
        observacion: e.observacion?.trim() || null,
        responsableId: actor.id,
      },
    });
    const articulo = await tx.articulo.findUniqueOrThrow({
      where: { id: e.articuloId },
      select: { codigo: true },
    });
    await this.bus.publish(
      tx,
      this.bus.create({
        type: 'operaciones.inventario.consumo_registrado',
        subject: { type: 'inventario_articulo', id: e.articuloId },
        data: {
          consumoId: c.id,
          articuloId: e.articuloId,
          articuloCodigo: articulo.codigo,
          ticketId: e.ticketPumpingId,
          cantidad: Number(c.cantidad),
        },
        actor: { userId: actor.id, role: actor.roleCode },
        traceparent: currentTraceparent(),
      }),
    );
    return c;
  }

  /** Salida de bodega que respalda un despacho solicitado desde el ciclo comercial. */
  async registrarSalidaDespacho(
    tx: Prisma.TransactionClient,
    e: MovimientoDeDespacho,
    actor: ActorInventario,
  ) {
    const d = await tx.despacho.findUnique({
      where: { id: e.despachoId },
      select: { estado: true },
    });
    if (!d) throw new NotFoundException('El despacho no existe');
    if (d.estado !== 'solicitado') {
      throw new ConflictException({
        message: 'El despacho ya fue realizado',
        code: 'DESPACHO_REALIZADO',
      });
    }
    return this.registrar(
      tx,
      { ...e, motivoId: await this.motivoDe(tx, 'despacho_bodega') },
      actor,
    );
  }

  /** Asignado, usado y devuelto de un ticket, por artículo (todo calculado). */
  balanceDeTicket(ticketPumpingId: string, articuloId?: string): Promise<BalanceTicketArticulo[]> {
    return balanceDeTicket(this.prisma, ticketPumpingId, articuloId);
  }

  /** Existencia de un artículo: en una bodega, o sumada en todas. Siempre del kardex. */
  async stockDe(articuloId: string, bodegaId?: string): Promise<number> {
    const saldos = await saldosPorBodega(this.prisma, articuloId);
    return saldos
      .filter((s) => !bodegaId || s.bodegaId === bodegaId)
      .reduce((t, s) => t + s.saldo, 0);
  }

  // --- pantalla ------------------------------------------------------------------------------------------------

  /** Movimiento manual de Bodega (compra, ajuste, baja): el motivo elegido fija el tipo y el origen. */
  async registrarManual(dto: RegistrarMovimientoDto, actor: ActorInventario) {
    return this.prisma.$transaction(async (tx) => {
      await this.exigirMotivoManual(tx, dto.motivoId);
      const m = await this.registrar(
        tx,
        {
          articuloId: dto.articuloId,
          bodegaId: dto.bodegaId,
          motivoId: dto.motivoId,
          cantidad: dto.cantidad,
          fecha: dto.fecha ? new Date(dto.fecha) : undefined,
          observacion: dto.observacion,
        },
        actor,
      );
      return vistaMovimiento(
        await tx.movimiento.findUniqueOrThrow({ where: { id: m.id }, include: INCLUIR }),
      );
    });
  }

  /** El kardex de un artículo: los últimos renglones, en orden cronológico. */
  async kardex(articuloId: string, f: ListarMovimientosDto) {
    if (
      !(await this.prisma.articulo.findUnique({ where: { id: articuloId }, select: { id: true } }))
    ) {
      throw new NotFoundException('El artículo no existe');
    }
    const filas = await this.prisma.movimiento.findMany({
      where: {
        articuloId,
        ...(f.bodegaId ? { bodegaId: f.bodegaId } : {}),
        ...(f.desde || f.hasta
          ? {
              fecha: {
                ...(f.desde ? { gte: new Date(f.desde) } : {}),
                ...(f.hasta ? { lte: new Date(f.hasta) } : {}),
              },
            }
          : {}),
      },
      include: INCLUIR,
      orderBy: { secuencia: 'desc' },
      take: f.limite ?? 200,
    });
    return filas.reverse().map(vistaMovimiento);
  }

  async stock(articuloId: string) {
    if (
      !(await this.prisma.articulo.findUnique({ where: { id: articuloId }, select: { id: true } }))
    ) {
      throw new NotFoundException('El artículo no existe');
    }
    const saldos = await saldosPorBodega(this.prisma, articuloId);
    const bodegas = await this.prisma.catBodega.findMany({
      where: { id: { in: saldos.map((s) => s.bodegaId) } },
    });
    return {
      articuloId,
      total: saldos.reduce((t, s) => t + s.saldo, 0),
      porBodega: saldos.map((s) => ({
        bodegaId: s.bodegaId,
        bodega: bodegas.find((b) => b.id === s.bodegaId)?.nombre ?? '',
        stock: s.saldo,
      })),
    };
  }

  // --- reglas de apoyo -------------------------------------------------------------------------------------------

  /** El motivo del sistema para un origen (se busca por su origen, nunca por su nombre). */
  private async motivoDe(tx: Prisma.TransactionClient, origen: OrigenMovimiento): Promise<string> {
    const m = await tx.motivoMovimiento.findFirst({
      where: { origen, activo: true },
      orderBy: { createdAt: 'asc' },
    });
    if (!m)
      throw new ConflictException({
        message: 'Falta el motivo de movimiento del sistema',
        code: 'MOTIVO_INVALIDO',
      });
    return m.id;
  }

  private async exigirMotivoManual(
    tx: Prisma.TransactionClient,
    motivoId: string,
    tipo?: 'entrada' | 'salida',
  ) {
    const m = await tx.motivoMovimiento.findUnique({ where: { id: motivoId } });
    if (!m || !m.activo || !m.manual || (tipo && m.tipo !== tipo)) {
      throw new ConflictException({
        message: 'Ese motivo no se puede registrar a mano',
        code: 'MOTIVO_NO_MANUAL',
      });
    }
  }

  /** Lo que el ticket aún tiene a su cargo (asignado − usado − devuelto) alcanza para la operación. */
  private async exigirPendiente(
    tx: Prisma.TransactionClient,
    ticketPumpingId: string,
    articuloId: string,
    cantidad: Prisma.Decimal,
    verbo: 'devolver' | 'consumir',
  ) {
    const [b] = await balanceDeTicket(tx, ticketPumpingId, articuloId);
    const pendiente = b?.pendiente ?? new Prisma.Decimal(0);
    if (cantidad.gt(pendiente)) {
      throw new ConflictException({
        message: `El ticket solo tiene a su cargo ${pendiente.toString()}: no se puede ${verbo} ${cantidad.toString()}`,
        code: 'EXCEDE_LO_ASIGNADO',
      });
    }
  }
}
