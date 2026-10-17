import { ConflictException, NotFoundException } from '@nestjs/common';
import { uuidv7 } from '@dyn/utils';
import { Prisma } from '../generated/client';

/** Lo que se registra en el kardex. El tipo y el origen salen del motivo; el saldo lo calcula esta función. */
export interface EntradaKardex {
  articuloId: string;
  bodegaId: string;
  motivoId: string;
  cantidad: Prisma.Decimal | number | string;
  responsableId: string;
  /** Por defecto, ahora. No puede ser futura. */
  fecha?: Date;
  observacion?: string | null;
  /** Obligatorio en las salidas y devoluciones de ticket; prohibido en los demás (lo exige la base). */
  ticketPumpingId?: string | null;
  /** Obligatorio en las salidas de despacho a bodega; prohibido en los demás. */
  despachoId?: string | null;
}

const TOLERANCIA_RELOJ_MS = 5 * 60 * 1000;

/** Bloqueo por artículo: los movimientos de un mismo artículo se serializan, así el saldo nunca se calcula sobre uno viejo. */
export async function bloquearArticulo(
  tx: Prisma.TransactionClient,
  articuloId: string,
): Promise<void> {
  const filas = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM inventario.articulo WHERE id = ${articuloId}::uuid FOR UPDATE`;
  if (!filas.length) throw new NotFoundException('El artículo no existe');
}

export function validarCantidad(cantidad: Prisma.Decimal): void {
  if (!cantidad.isFinite() || cantidad.lte(0)) {
    throw new ConflictException({
      message: 'La cantidad debe ser mayor que cero',
      code: 'CANTIDAD_INVALIDA',
    });
  }
  if (cantidad.decimalPlaces() > 3) {
    throw new ConflictException({
      message: 'La cantidad admite hasta 3 decimales',
      code: 'CANTIDAD_INVALIDA',
    });
  }
}

/**
 * Registra un renglón del kardex dentro de la transacción recibida. Bloquea la fila del artículo, toma el saldo anterior de esa
 * bodega y rechaza una salida que lo deje en negativo. Es la ÚNICA puerta de escritura del kardex: el cargador inicial y los
 * servicios la usan por igual. La coherencia entre motivo, tipo y origen, y la de las referencias, las garantiza también la base.
 */
export async function registrarEnKardex(tx: Prisma.TransactionClient, e: EntradaKardex) {
  const cantidad = new Prisma.Decimal(e.cantidad);
  validarCantidad(cantidad);
  const fecha = e.fecha ?? new Date();
  if (fecha.getTime() > Date.now() + TOLERANCIA_RELOJ_MS) {
    throw new ConflictException({
      message: 'La fecha del movimiento no puede ser futura',
      code: 'FECHA_FUTURA',
    });
  }

  await bloquearArticulo(tx, e.articuloId);

  const motivo = await tx.motivoMovimiento.findUnique({ where: { id: e.motivoId } });
  if (!motivo || !motivo.activo) {
    throw new ConflictException({
      message: 'El motivo del movimiento no existe o está inactivo',
      code: 'MOTIVO_INVALIDO',
    });
  }
  const bodega = await tx.catBodega.findUnique({ where: { id: e.bodegaId } });
  if (!bodega || !bodega.habilitado) {
    throw new ConflictException({
      message: 'La bodega no existe o está deshabilitada',
      code: 'BODEGA_INVALIDA',
    });
  }
  if (
    e.ticketPumpingId &&
    !(await tx.pumpTicket.findUnique({ where: { id: e.ticketPumpingId }, select: { id: true } }))
  ) {
    throw new ConflictException({ message: 'El ticket no existe', code: 'TICKET_INVALIDO' });
  }

  const ultimo = await tx.movimiento.findFirst({
    where: { articuloId: e.articuloId, bodegaId: e.bodegaId },
    orderBy: { secuencia: 'desc' },
    select: { saldoResultante: true },
  });
  const anterior = ultimo?.saldoResultante ?? new Prisma.Decimal(0);
  const saldo = motivo.tipo === 'entrada' ? anterior.plus(cantidad) : anterior.minus(cantidad);
  if (saldo.lt(0)) {
    throw new ConflictException({
      message: `Stock insuficiente: hay ${anterior.toString()} en la bodega y se piden ${cantidad.toString()}`,
      code: 'STOCK_INSUFICIENTE',
    });
  }

  return tx.movimiento.create({
    data: {
      id: uuidv7(),
      articuloId: e.articuloId,
      bodegaId: e.bodegaId,
      tipo: motivo.tipo,
      origen: motivo.origen,
      motivoId: motivo.id,
      cantidad,
      saldoResultante: saldo,
      fecha,
      observacion: e.observacion?.trim() || null,
      responsableId: e.responsableId,
      ticketPumpingId: e.ticketPumpingId ?? null,
      despachoId: e.despachoId ?? null,
    },
  });
}

/** Saldo por bodega de un artículo (el último renglón de cada bodega). */
export async function saldosPorBodega(
  db: Pick<Prisma.TransactionClient, '$queryRaw'>,
  articuloId: string,
): Promise<Array<{ bodegaId: string; saldo: number }>> {
  const filas = await db.$queryRaw<Array<{ bodega_id: string; saldo: Prisma.Decimal }>>`
    SELECT DISTINCT ON (bodega_id) bodega_id, saldo_resultante AS saldo
      FROM inventario.movimiento
     WHERE articulo_id = ${articuloId}::uuid
     ORDER BY bodega_id, secuencia DESC`;
  return filas.map((f) => ({ bodegaId: f.bodega_id, saldo: Number(f.saldo) }));
}

export interface BalanceTicketArticulo {
  articuloId: string;
  /** Lo que salió de bodega para el ticket. */
  asignada: Prisma.Decimal;
  /** Lo que se registró como usado en la ejecución. */
  usada: Prisma.Decimal;
  /** Lo que volvió a bodega. */
  devuelta: Prisma.Decimal;
  /** Lo que sigue en poder del ticket: asignada − usada − devuelta. */
  pendiente: Prisma.Decimal;
}

/** Asignado, usado y devuelto de un ticket, por artículo. Todo sale del kardex y del consumo: nada de esto se guarda aparte. */
export async function balanceDeTicket(
  tx: Pick<Prisma.TransactionClient, 'movimiento' | 'consumoTicket'>,
  ticketPumpingId: string,
  articuloId?: string,
): Promise<BalanceTicketArticulo[]> {
  const donde = { ticketPumpingId, ...(articuloId ? { articuloId } : {}) };
  const [movs, consumos] = await Promise.all([
    tx.movimiento.groupBy({ by: ['articuloId', 'origen'], where: donde, _sum: { cantidad: true } }),
    tx.consumoTicket.groupBy({ by: ['articuloId'], where: donde, _sum: { cantidad: true } }),
  ]);
  const cero = new Prisma.Decimal(0);
  const ids = new Set([...movs.map((m) => m.articuloId), ...consumos.map((c) => c.articuloId)]);
  return [...ids].map((id) => {
    const suma = (origen: string) =>
      movs.find((m) => m.articuloId === id && m.origen === origen)?._sum.cantidad ?? cero;
    const asignada = suma('salida_ticket');
    const devuelta = suma('devolucion_ticket');
    const usada = consumos.find((c) => c.articuloId === id)?._sum.cantidad ?? cero;
    return {
      articuloId: id,
      asignada,
      usada,
      devuelta,
      pendiente: asignada.minus(usada).minus(devuelta),
    };
  });
}
