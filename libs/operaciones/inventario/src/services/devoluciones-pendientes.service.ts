import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { ListarDevolucionesPendientesDto } from '../dto/inventario.dto';
import { Prisma } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import { balanceDeTicket, bloquearArticulo } from './kardex';
import { MovimientosService, type ActorInventario } from './movimientos.service';

const INCLUIR = {
  articulo: { select: { id: true, codigo: true, nombre: true } },
  bodega: { select: { id: true, nombre: true } },
  resolvio: { select: { id: true, nombre: true } },
} satisfies Prisma.DevolucionPendienteInclude;

type FilaConNombres = Prisma.DevolucionPendienteGetPayload<{ include: typeof INCLUIR }>;

/**
 * Devoluciones pendientes de Bodega: lo que la anulación de un pedido no pudo devolver y sigue a cargo del ticket. Bodega las ve en su lista de
 * tareas y las resuelve registrando la devolución (un movimiento normal del kardex, con ella como autora).
 */
@Injectable()
export class DevolucionesPendientesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly movimientos: MovimientosService,
  ) {}

  async listar(f: ListarDevolucionesPendientesDto) {
    const filas = await this.prisma.devolucionPendiente.findMany({
      where: { resueltaAt: f.estado === 'resuelta' ? { not: null } : null },
      include: INCLUIR,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 500,
    });
    return this.vista(filas);
  }

  /**
   * Bodega resuelve la devolución: devuelve a esa bodega lo que sigue a cargo del ticket, hasta la cantidad pendiente (si entretanto algo
   * ya volvió o se usó, devuelve solo lo que queda y la fila se cierra igual). Resolver otra vez la misma fila es un conflicto.
   */
  async resolver(id: string, actor: ActorInventario) {
    return this.prisma.$transaction(async (tx) => {
      const previa = await tx.devolucionPendiente.findUnique({ where: { id } });
      if (!previa) throw new NotFoundException('La devolución pendiente no existe');
      // primero el artículo y luego la fila: el mismo orden que la anulación, así no se bloquean entre sí
      await bloquearArticulo(tx, previa.articuloId);
      await tx.$queryRaw`SELECT id FROM inventario.devolucion_pendiente WHERE id = ${id}::uuid FOR UPDATE`;
      const d = await tx.devolucionPendiente.findUniqueOrThrow({ where: { id } });
      if (d.resueltaAt) {
        throw new ConflictException({
          message: 'Esa devolución ya fue resuelta',
          code: 'DEVOLUCION_RESUELTA',
        });
      }
      const [b] = await balanceDeTicket(tx, d.ticketPumpingId, d.articuloId);
      const cantidad = Prisma.Decimal.min(d.cantidad, b?.pendiente ?? new Prisma.Decimal(0));
      const m = cantidad.gt(0)
        ? await this.movimientos.registrarDevolucion(
            tx,
            {
              ticketPumpingId: d.ticketPumpingId,
              articuloId: d.articuloId,
              bodegaId: d.bodegaId,
              cantidad: cantidad.toString(),
              observacion: 'Devolución pendiente por anulación del pedido',
            },
            actor,
          )
        : null;
      await tx.devolucionPendiente.update({
        where: { id },
        data: { resueltaAt: new Date(), resueltaPor: actor.id, movimientoId: m?.id ?? null },
      });
      const fila = await tx.devolucionPendiente.findUniqueOrThrow({
        where: { id },
        include: INCLUIR,
      });
      const [vista] = await this.vista([fila], tx);
      return { ...vista, devuelta: cantidad.toNumber() };
    });
  }

  /** Las filas con sus nombres y el ticket (número y pedido) de Pumping, por JOIN. */
  private async vista(
    filas: FilaConNombres[],
    db: Pick<Prisma.TransactionClient, '$queryRaw'> = this.prisma,
  ) {
    const ids = [...new Set(filas.map((f) => f.ticketPumpingId))];
    const tickets = ids.length
      ? await db.$queryRaw<
          Array<{ id: string; ticket_numero: number | null; pedido_codigo: string }>
        >`SELECT id, ticket_numero, pedido_codigo FROM pumping.ticket WHERE id = ANY(${ids}::uuid[])`
      : [];
    return filas.map((f) => {
      const t = tickets.find((x) => x.id === f.ticketPumpingId);
      return {
        id: f.id,
        ticketId: f.ticketPumpingId,
        ticketNumero: t?.ticket_numero ?? null,
        pedidoCodigo: t?.pedido_codigo ?? null,
        articulo: f.articulo,
        bodega: f.bodega,
        cantidad: Number(f.cantidad),
        motivo: f.motivo,
        creadaAt: f.createdAt.toISOString(),
        resueltaAt: f.resueltaAt?.toISOString() ?? null,
        resueltaPor: f.resolvio,
        movimientoId: f.movimientoId,
      };
    });
  }
}
