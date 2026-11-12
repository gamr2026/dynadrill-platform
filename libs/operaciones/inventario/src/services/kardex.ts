import { ConflictException, NotFoundException } from '@nestjs/common';
import { uuidv7 } from '@dyn/utils';
import { Prisma } from '../generated/client';

/** Lo que se registra en el kardex. El tipo y el origen salen del motivo; el saldo lo calcula esta función. */
export interface EntradaKardex {
  articuloId: string;
  bodegaId: string;
  motivoId: string;
  cantidad: Prisma.Decimal | number | string;
  /** Vacío solo en la devolución por anulación, que la registra el sistema (lo exige la base). */
  responsableId: string | null;
  /** Solo en la devolución por anulación: la cuenta que anuló el pedido, si se sabe. */
  aPedidoDeId?: string | null;
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
      aPedidoDeId: e.aPedidoDeId ?? null,
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
    const devuelta = suma('devolucion_ticket').plus(suma('devolucion_anulacion'));
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

/** Lo que un ticket tiene todavía en poder suyo, de lo que salió de cada bodega (salidas − devoluciones a esa bodega). */
export interface EnPoderPorBodega {
  articuloId: string;
  bodegaId: string;
  salida: Prisma.Decimal;
  devuelta: Prisma.Decimal;
  enPoder: Prisma.Decimal;
}

/**
 * Por artículo y bodega: cuánto salió para el ticket, cuánto volvió a esa bodega y cuánto sigue en poder del ticket. El consumo no se
 * anota por bodega, así que la suma de `enPoder` de un artículo puede superar lo que el ticket aún tiene a su cargo (lo usado).
 */
export async function enPoderPorBodega(
  tx: Pick<Prisma.TransactionClient, 'movimiento'>,
  ticketPumpingId: string,
  articuloId?: string,
): Promise<EnPoderPorBodega[]> {
  const filas = await tx.movimiento.groupBy({
    by: ['articuloId', 'bodegaId', 'origen'],
    where: {
      ticketPumpingId,
      origen: { in: ['salida_ticket', 'devolucion_ticket', 'devolucion_anulacion'] },
      ...(articuloId ? { articuloId } : {}),
    },
    _sum: { cantidad: true },
  });
  const cero = new Prisma.Decimal(0);
  const claves = new Map<string, { articuloId: string; bodegaId: string }>();
  for (const f of filas) claves.set(`${f.articuloId}|${f.bodegaId}`, f);
  return [...claves.values()]
    .map(({ articuloId: a, bodegaId: b }) => {
      const suma = (origenes: string[]) =>
        filas
          .filter((f) => f.articuloId === a && f.bodegaId === b && origenes.includes(f.origen))
          .reduce((t, f) => t.plus(f._sum.cantidad ?? cero), cero);
      const salida = suma(['salida_ticket']);
      const devuelta = suma(['devolucion_ticket', 'devolucion_anulacion']);
      return { articuloId: a, bodegaId: b, salida, devuelta, enPoder: salida.minus(devuelta) };
    })
    .sort((x, y) => x.bodegaId.localeCompare(y.bodegaId));
}

/**
 * Reparte `total` entre las bodegas en proporción a lo que cada una tiene en poder del ticket (milésimas, como el kardex) y nunca pone en una
 * más de lo que tiene en poder. Lo que sobra del redondeo va a las de mayor peso. Sin peso suficiente para cubrir `total`, devuelve lo que alcanza.
 */
export function repartirEnProporcion(
  total: Prisma.Decimal,
  bodegas: ReadonlyArray<{ bodegaId: string; enPoder: Prisma.Decimal }>,
): Array<{ bodegaId: string; cantidad: Prisma.Decimal }> {
  const cero = new Prisma.Decimal(0);
  const con = bodegas.filter((b) => b.enPoder.gt(0));
  const suma = con.reduce((t, b) => t.plus(b.enPoder), cero);
  if (!con.length || total.lte(0)) return [];
  const aRepartir = Prisma.Decimal.min(total, suma);
  const partes = con.map((b) => ({
    bodegaId: b.bodegaId,
    tope: b.enPoder,
    cantidad: aRepartir.times(b.enPoder).div(suma).toDecimalPlaces(3, Prisma.Decimal.ROUND_DOWN),
  }));
  let resto = aRepartir.minus(partes.reduce((t, p) => t.plus(p.cantidad), cero));
  for (const p of [...partes].sort((x, y) => y.tope.comparedTo(x.tope))) {
    if (resto.lte(0)) break;
    const extra = Prisma.Decimal.min(resto, p.tope.minus(p.cantidad));
    p.cantidad = p.cantidad.plus(extra);
    resto = resto.minus(extra);
  }
  return partes
    .filter((p) => p.cantidad.gt(0))
    .map(({ bodegaId, cantidad }) => ({ bodegaId, cantidad }));
}
