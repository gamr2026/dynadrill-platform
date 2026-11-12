import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { currentTraceparent, type AuthUser } from '@dyn/common';
import { EventBus } from '@dyn/messaging';
import { uuidv7 } from '@dyn/utils';
import type { ListarMovimientosDto, RegistrarMovimientoDto } from '../dto/inventario.dto';
import { Prisma, type OrigenMovimiento } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  balanceDeTicket,
  bloquearArticulo,
  enPoderPorBodega,
  registrarEnKardex,
  repartirEnProporcion,
  saldosPorBodega,
  validarCantidad,
  type BalanceTicketArticulo,
  type EntradaKardex,
} from './kardex';
import { MinimosService } from './minimos.service';

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
  /** Día del servicio (`AAAA-MM-DD`) en que se usó; por omisión, hoy en Ecuador. */
  diaServicio?: string;
}

export interface MovimientoDeDespacho {
  despachoId: string;
  articuloId: string;
  bodegaId: string;
  cantidad: number | string;
  observacion?: string | null;
}

/** Un renglón de repuesto de Mantenimiento que debe salir de bodega. */
export interface SalidaDeMantenimiento {
  /** `mantenimiento.suborden_repuesto.id`: llave de idempotencia (un renglón sale una sola vez). */
  subordenRepuestoId: string;
  articuloId: string;
  bodegaId: string;
  cantidad: number | string;
  observacion?: string | null;
}

/** Lo que la anulación de un pedido hizo con un químico en una bodega: lo que volvió a ella y lo que quedó como devolución pendiente para Bodega. */
export interface DevolucionPorAnulacion {
  articuloId: string;
  bodegaId: string;
  devuelta: number;
  pendiente: number;
}

/** Un renglón de químico que sale de bodega (o vuelve a ella) por un ticket de Pumping. */
export interface LineaDeTicket {
  articuloId: string;
  bodegaId: string;
  cantidad: number | string;
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
  devolucion_anulacion: 'operaciones.inventario.devolucion_registrada',
};
const EVENTO_GENERICO = 'operaciones.inventario.movimiento_registrado';
/** IN4: una salida dejó el saldo de un artículo en una bodega por debajo de su mínimo (se publica al cruzarlo, no en cada movimiento). */
export const EVENTO_BAJO_MINIMO = 'operaciones.inventario.stock.bajo_minimo';

/**
 * Kardex de Inventario. Es la puerta de entrada de los demás módulos del contenedor: cada método recibe la transacción de quien
 * llama (una sola `tx`), de modo que el movimiento, el evento y el cambio del otro módulo se confirman o se revierten juntos.
 */
@Injectable()
export class MovimientosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: EventBus,
    private readonly minimos: MinimosService,
  ) {}

  /** Registra el movimiento y publica su evento, dentro de la transacción recibida. */
  async registrar(
    tx: Prisma.TransactionClient,
    entrada: Omit<EntradaKardex, 'responsableId'>,
    actor: ActorInventario | null,
  ) {
    const m = await registrarEnKardex(tx, { ...entrada, responsableId: actor?.id ?? null });
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
        ...(actor ? { actor: { userId: actor.id, role: actor.roleCode } } : {}),
        traceparent: currentTraceparent(),
      }),
    );
    // IN4: si la salida dejó el saldo por debajo del mínimo (viniendo de estar en él o encima), se avisa una sola vez
    const cruce = await this.minimos.cruzo(tx, m);
    if (cruce) {
      const bodega = await tx.catBodega.findUnique({
        where: { id: m.bodegaId },
        select: { nombre: true },
      });
      await this.bus.publish(
        tx,
        this.bus.create({
          type: EVENTO_BAJO_MINIMO,
          subject: { type: 'inventario_articulo', id: m.articuloId },
          data: {
            articuloId: m.articuloId,
            articuloCodigo: articulo.codigo,
            bodegaId: m.bodegaId,
            bodega: bodega?.nombre ?? null,
            saldo: cruce.saldo,
            minimo: cruce.minimo,
            movimientoId: m.id,
            ticketId: m.ticketPumpingId,
          },
          ...(actor ? { actor: { userId: actor.id, role: actor.roleCode } } : {}),
          traceparent: currentTraceparent(),
        }),
      );
    }
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
    return this.devolverAlKardex(tx, e, 'devolucion_ticket', actor, null);
  }

  /**
   * Devolución a bodega por anulación del pedido: la registra el sistema (sin autor ni rol), con quién anuló el pedido como referencia
   * cuando se sabe. Mismo núcleo que `registrarDevolucion`: no devuelve más de lo que sigue a cargo del ticket.
   */
  async registrarDevolucionPorAnulacion(
    tx: Prisma.TransactionClient,
    e: MovimientoDeTicket,
    aPedidoDeId: string | null,
  ) {
    return this.devolverAlKardex(tx, e, 'devolucion_anulacion', null, aPedidoDeId);
  }

  /** Núcleo de toda devolución de ticket: cantidad válida, artículo bloqueado y nada por encima de lo que el ticket tiene a su cargo. */
  private async devolverAlKardex(
    tx: Prisma.TransactionClient,
    e: MovimientoDeTicket,
    origen: 'devolucion_ticket' | 'devolucion_anulacion',
    actor: ActorInventario | null,
    aPedidoDeId: string | null,
  ) {
    const cantidad = new Prisma.Decimal(e.cantidad);
    validarCantidad(cantidad);
    await bloquearArticulo(tx, e.articuloId);
    await this.exigirPendiente(tx, e.ticketPumpingId, e.articuloId, cantidad, 'devolver');
    return this.registrar(
      tx,
      { ...e, motivoId: await this.motivoDe(tx, origen), aPedidoDeId },
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
    if (
      e.diaServicio !== undefined &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(e.diaServicio) ||
        Number.isNaN(Date.parse(`${e.diaServicio}T00:00:00Z`)))
    )
      throw new BadRequestException('El día del servicio debe tener el formato AAAA-MM-DD');
    await this.exigirPendiente(tx, e.ticketPumpingId, e.articuloId, cantidad, 'consumir');
    const c = await tx.consumoTicket.create({
      data: {
        id: uuidv7(),
        ticketPumpingId: e.ticketPumpingId,
        articuloId: e.articuloId,
        cantidad,
        fecha: new Date(),
        ...(e.diaServicio ? { diaServicio: new Date(`${e.diaServicio}T00:00:00Z`) } : {}),
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
          diaServicio: c.diaServicio.toISOString().slice(0, 10),
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

  /**
   * Salida de bodega de los repuestos de una sub-orden de Mantenimiento, todos en UNA transacción de Inventario (o salen todos o
   * ninguno). Es idempotente por renglón: lo que ya salió devuelve su movimiento sin duplicar la salida, de modo que el cierre de la
   * sub-orden se puede reintentar. Devuelve el movimiento de cada renglón. Mantenimiento no puede compartir su transacción con la
   * de Inventario (cada módulo tiene su propio cliente de base de datos), por eso esta puerta abre la suya.
   */
  async registrarSalidasDeMantenimiento(
    lineas: SalidaDeMantenimiento[],
    actor: ActorInventario,
  ): Promise<Map<string, string>> {
    return this.prisma.$transaction(async (tx) => {
      const motivoId = await this.motivoDe(tx, 'consumo_mantenimiento');
      const movimientos = new Map<string, string>();
      for (const l of lineas) {
        const previa = await tx.salidaMantenimiento.findUnique({
          where: { subordenRepuestoId: l.subordenRepuestoId },
        });
        if (previa) {
          movimientos.set(l.subordenRepuestoId, previa.movimientoId);
          continue;
        }
        const m = await this.registrar(
          tx,
          {
            articuloId: l.articuloId,
            bodegaId: l.bodegaId,
            motivoId,
            cantidad: l.cantidad,
            observacion: l.observacion ?? null,
          },
          actor,
        );
        await tx.salidaMantenimiento.create({
          data: { subordenRepuestoId: l.subordenRepuestoId, movimientoId: m.id },
        });
        movimientos.set(l.subordenRepuestoId, m.id);
      }
      return movimientos;
    });
  }

  // --- API de los demás módulos del contenedor con TRANSACCIÓN PROPIA ---------------------------------------
  // Pumping y Mantenimiento tienen su propio cliente de base de datos: no pueden pasar su `tx` a los métodos de arriba. Estos abren la
  // transacción de Inventario (todas las líneas o ninguna) y devuelven lo registrado; quien llama guarda lo que necesite de su lado.

  /**
   * Salida de bodega de los químicos de un ticket de Pumping (la asignación del Jefe de Base). Solo artículos de categorías de
   * químicos. Stock insuficiente → 409 y no sale nada.
   */
  async registrarSalidasDeTicket(
    ticketPumpingId: string,
    lineas: LineaDeTicket[],
    actor: ActorInventario,
    observacion?: string | null,
  ) {
    return this.prisma.$transaction(async (tx) => {
      await this.exigirQuimicos(tx, lineas);
      const registrados = [];
      for (const l of lineas) {
        registrados.push(
          await this.registrarSalida(
            tx,
            {
              ticketPumpingId,
              articuloId: l.articuloId,
              bodegaId: l.bodegaId,
              cantidad: l.cantidad,
              observacion,
            },
            actor,
          ),
        );
      }
      return registrados.map((m) => ({
        movimientoId: m.id,
        articuloId: m.articuloId,
        cantidad: Number(m.cantidad),
      }));
    });
  }

  /** Lo no usado vuelve a bodega (control de retorno; también deshace una salida si el ticket no pudo asignarse). */
  async devolverDeTicket(
    ticketPumpingId: string,
    lineas: LineaDeTicket[],
    actor: ActorInventario,
    observacion?: string | null,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const registrados = [];
      for (const l of lineas) {
        registrados.push(
          await this.registrarDevolucion(
            tx,
            {
              ticketPumpingId,
              articuloId: l.articuloId,
              bodegaId: l.bodegaId,
              cantidad: l.cantidad,
              observacion,
            },
            actor,
          ),
        );
      }
      return registrados.map((m) => ({
        movimientoId: m.id,
        articuloId: m.articuloId,
        cantidad: Number(m.cantidad),
      }));
    });
  }

  /**
   * Lo que el ticket aún tiene a su cargo vuelve a las bodegas de las que salió, en proporción a lo que cada una tiene en poder del ticket
   * (nunca más de eso por bodega). Lo inicia el sistema cuando se anula el pedido: no depende de ningún rol ni de que se sepa quién lo anuló
   * (`aPedidoDeId` es solo la referencia). Cada artículo es una transacción: o vuelve entero o queda como devolución pendiente (una fila por
   * artículo y bodega) a la vista de Bodega, así lo que falla no se pierde ni frena a los demás. Se puede repetir: el balance sale del kardex,
   * de modo que lo ya devuelto no vuelve a devolverse, y la fila pendiente abierta es única por ticket, artículo y bodega.
   */
  async devolverPorAnulacion(
    ticketPumpingId: string,
    aPedidoDeId: string | null,
    motivo = 'Pedido anulado',
  ): Promise<DevolucionPorAnulacion[]> {
    const balance = await balanceDeTicket(this.prisma, ticketPumpingId);
    for (const b of balance.filter((x) => x.pendiente.gt(0))) {
      try {
        await this.prisma.$transaction((tx) =>
          this.devolverArticuloPorAnulacion(tx, ticketPumpingId, b.articuloId, aPedidoDeId, motivo),
        );
      } catch (e) {
        await this.dejarPendiente(ticketPumpingId, b.articuloId, e);
      }
    }
    return this.resumenDeAnulacion(ticketPumpingId);
  }

  /**
   * Lo que la anulación devolvió a cada bodega (del kardex, así un reintento lo reporta igual) y lo que quedó pendiente de devolver (filas
   * abiertas de `devolucion_pendiente`), por artículo y bodega.
   */
  async resumenDeAnulacion(ticketPumpingId: string): Promise<DevolucionPorAnulacion[]> {
    const [devueltas, pendientes] = await Promise.all([
      this.prisma.movimiento.groupBy({
        by: ['articuloId', 'bodegaId'],
        where: { ticketPumpingId, origen: 'devolucion_anulacion' },
        _sum: { cantidad: true },
      }),
      this.prisma.devolucionPendiente.findMany({ where: { ticketPumpingId, resueltaAt: null } }),
    ]);
    const lineas = new Map<string, DevolucionPorAnulacion>();
    const de = (articuloId: string, bodegaId: string) => {
      const k = `${articuloId}|${bodegaId}`;
      if (!lineas.has(k)) lineas.set(k, { articuloId, bodegaId, devuelta: 0, pendiente: 0 });
      return lineas.get(k) as DevolucionPorAnulacion;
    };
    for (const d of devueltas) de(d.articuloId, d.bodegaId).devuelta = Number(d._sum.cantidad ?? 0);
    for (const p of pendientes) de(p.articuloId, p.bodegaId).pendiente = Number(p.cantidad);
    return [...lineas.values()];
  }

  /** Un artículo del ticket vuelve a sus bodegas dentro de la transacción recibida; lo que una pasada anterior dejó pendiente de él se cierra. */
  private async devolverArticuloPorAnulacion(
    tx: Prisma.TransactionClient,
    ticketPumpingId: string,
    articuloId: string,
    aPedidoDeId: string | null,
    motivo: string,
  ): Promise<void> {
    for (const r of await this.repartoDeAnulacion(tx, ticketPumpingId, articuloId)) {
      await this.registrarDevolucionPorAnulacion(
        tx,
        {
          ticketPumpingId,
          articuloId,
          bodegaId: r.bodegaId,
          cantidad: r.cantidad.toString(),
          observacion: motivo,
        },
        aPedidoDeId,
      );
    }
    await tx.devolucionPendiente.updateMany({
      where: { ticketPumpingId, articuloId, resueltaAt: null },
      data: { resueltaAt: new Date() },
    });
  }

  /** Cuánto devolver a cada bodega de un artículo del ticket (bloquea el artículo: el balance no cambia mientras se reparte). */
  private async repartoDeAnulacion(
    tx: Prisma.TransactionClient,
    ticketPumpingId: string,
    articuloId: string,
  ) {
    await bloquearArticulo(tx, articuloId);
    const [b] = await balanceDeTicket(tx, ticketPumpingId, articuloId);
    if (!b || b.pendiente.lte(0)) return [];
    return repartirEnProporcion(
      b.pendiente,
      await enPoderPorBodega(tx, ticketPumpingId, articuloId),
    );
  }

  /** La devolución de un artículo falló: queda como devolución pendiente (una abierta por ticket, artículo y bodega), sin duplicar en un reintento. */
  private async dejarPendiente(
    ticketPumpingId: string,
    articuloId: string,
    causa: unknown,
  ): Promise<void> {
    const mensaje = causa instanceof Error ? causa.message : String(causa);
    const motivo = `No se pudo devolver al anular el pedido: ${mensaje}`.slice(0, 500);
    await this.prisma.$transaction(async (tx) => {
      const reparto = await this.repartoDeAnulacion(tx, ticketPumpingId, articuloId);
      // `skipDuplicates`: si ya hay una abierta para ese ticket, artículo y bodega (un reintento), no se crea otra
      await tx.devolucionPendiente.createMany({
        data: reparto.map((r) => ({
          id: uuidv7(),
          ticketPumpingId,
          articuloId,
          bodegaId: r.bodegaId,
          cantidad: r.cantidad,
          motivo,
        })),
        skipDuplicates: true,
      });
    });
  }

  /** Lo usado en la ejecución: no mueve stock; no puede superar lo que el ticket aún tiene a su cargo. */
  async registrarConsumoDeTicket(
    ticketPumpingId: string,
    articuloId: string,
    cantidad: number | string,
    actor: ActorInventario,
    observacion?: string | null,
    diaServicio?: string,
  ) {
    const c = await this.prisma.$transaction((tx) =>
      this.registrarConsumo(
        tx,
        { ticketPumpingId, articuloId, cantidad, observacion, diaServicio },
        actor,
      ),
    );
    return {
      consumoId: c.id,
      articuloId: c.articuloId,
      cantidad: Number(c.cantidad),
      diaServicio: c.diaServicio.toISOString().slice(0, 10),
    };
  }

  /** Los químicos de un ticket con su código, nombre y unidad: asignado, usado, devuelto y lo que sigue a su cargo. */
  async quimicosDeTicket(ticketPumpingId: string) {
    const balance = await balanceDeTicket(this.prisma, ticketPumpingId);
    const articulos = await this.prisma.articulo.findMany({
      where: { id: { in: balance.map((b) => b.articuloId) } },
      include: { unidadStock: true },
    });
    // las bodegas de las que salió cada químico: a ellas se puede devolver
    const salidas = await this.prisma.movimiento.groupBy({
      by: ['articuloId', 'bodegaId'],
      where: { ticketPumpingId, origen: 'salida_ticket' },
    });
    const bodegas = await this.prisma.catBodega.findMany({
      where: { id: { in: [...new Set(salidas.map((s) => s.bodegaId))] } },
    });
    // lo que cada bodega entregó al ticket y lo que le devolvió
    const poderes = await enPoderPorBodega(this.prisma, ticketPumpingId);
    // lo usado cada día del servicio
    const porDia = await this.prisma.consumoTicket.groupBy({
      by: ['articuloId', 'diaServicio'],
      where: { ticketPumpingId },
      _sum: { cantidad: true },
      orderBy: { diaServicio: 'asc' },
    });
    return balance
      .map((b) => {
        const a = articulos.find((x) => x.id === b.articuloId);
        return {
          articuloId: b.articuloId,
          codigo: a?.codigo ?? '',
          nombre: a?.nombre ?? '',
          unidad: a?.unidadStock.simbolo ?? '',
          asignada: Number(b.asignada),
          usada: Number(b.usada),
          devuelta: Number(b.devuelta),
          pendiente: Number(b.pendiente),
          /** Lo usado cada día del servicio. */
          usadaPorDia: porDia
            .filter((d) => d.articuloId === b.articuloId)
            .map((d) => ({
              fecha: d.diaServicio.toISOString().slice(0, 10),
              cantidad: Number(d._sum.cantidad ?? 0),
            })),
          bodegas: salidas
            .filter((s) => s.articuloId === b.articuloId)
            .map((s) => {
              const p = poderes.find(
                (x) => x.articuloId === b.articuloId && x.bodegaId === s.bodegaId,
              );
              return {
                bodegaId: s.bodegaId,
                bodega: bodegas.find((x) => x.id === s.bodegaId)?.nombre ?? '',
                /** Lo que salió de esa bodega para el ticket, lo que volvió a ella y lo que sigue en poder del ticket. */
                salida: Number(p?.salida ?? 0),
                devuelta: Number(p?.devuelta ?? 0),
                enPoder: Number(p?.enPoder ?? 0),
              };
            }),
        };
      })
      .sort((x, y) => x.codigo.localeCompare(y.codigo));
  }

  private async exigirQuimicos(tx: Prisma.TransactionClient, lineas: LineaDeTicket[]) {
    const ids = [...new Set(lineas.map((l) => l.articuloId))];
    const articulos = await tx.articulo.findMany({
      where: { id: { in: ids } },
      include: { categoria: true },
    });
    for (const id of ids) {
      const a = articulos.find((x) => x.id === id);
      if (!a) throw new NotFoundException('El artículo no existe');
      if (!a.categoria.esQuimica) {
        throw new ConflictException({
          message: `${a.codigo} no es un químico: solo los químicos se asignan a un ticket`,
          code: 'ARTICULO_NO_QUIMICO',
        });
      }
    }
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
    const minimos = await this.minimos.deArticulo(articuloId);
    // una bodega con mínimo y sin movimientos también cuenta: tiene 0 y está por debajo
    const filas = [
      ...saldos,
      ...[...minimos.keys()]
        .filter((id) => !saldos.some((s) => s.bodegaId === id))
        .map((bodegaId) => ({ bodegaId, saldo: 0 })),
    ];
    const bodegas = await this.prisma.catBodega.findMany({
      where: { id: { in: filas.map((s) => s.bodegaId) } },
    });
    return {
      articuloId,
      total: saldos.reduce((t, s) => t + s.saldo, 0),
      porBodega: filas.map((s) => {
        const minimo = minimos.get(s.bodegaId) ?? null;
        return {
          bodegaId: s.bodegaId,
          bodega: bodegas.find((b) => b.id === s.bodegaId)?.nombre ?? '',
          stock: s.saldo,
          minimo,
          bajoMinimo: minimo !== null && s.saldo < minimo,
        };
      }),
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
