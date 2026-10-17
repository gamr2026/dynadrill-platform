import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { EventEnvelope } from '@dyn/messaging';
import { uuidv7 } from '@dyn/utils';
import type { ListarDespachosDto, SalidaDespachoDto } from '../dto/inventario.dto';
import type { Prisma } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  INCLUIR_MOVIMIENTO,
  MovimientosService,
  vistaMovimiento,
  type ActorInventario,
} from './movimientos.service';

const esUuid = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

/**
 * Despachos a bodega: refleja lo que el ciclo comercial publica (`comercial.despacho.solicitado|resuelto`) y deja registrar las
 * salidas de stock que lo respaldan. La marca «realizado» (con su documento de respaldo y la hoja MSDS) la pone comercial; aquí solo
 * se copia por evento. Los consumidores ignoran sin error lo que no entienden (datos faltantes, cuentas o archivos que no existen).
 */
@Injectable()
export class DespachosService {
  private readonly logger = new Logger(DespachosService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly movimientos: MovimientosService,
  ) {}

  /** `comercial.despacho.solicitado`: abre (o reabre) la solicitud del pedido. */
  async alSolicitar(tx: Prisma.TransactionClient, event: EventEnvelope): Promise<void> {
    const pedidoId = event.data['pedidoId'];
    const actorId = event.actor?.userId;
    if (
      !esUuid(pedidoId) ||
      !esUuid(actorId) ||
      !(await tx.idUsuario.findUnique({ where: { id: actorId }, select: { id: true } }))
    ) {
      this.logger.warn(
        `Evento ${event.id}: despacho solicitado sin pedido o sin cuenta válida; se ignora`,
      );
      return;
    }
    const at = new Date(event.occurredAt);
    const abierto = {
      estado: 'solicitado' as const,
      solicitadoAt: at,
      solicitadoPorId: actorId,
      realizadoAt: null,
      realizadoPorId: null,
      archivoRespaldoId: null,
      archivoMsdsId: null,
      updatedBy: actorId,
    };
    await tx.despacho.upsert({
      where: { pedidoId },
      create: { id: uuidv7(), pedidoId, createdBy: actorId, ...abierto },
      update: abierto,
    });
  }

  /** `comercial.despacho.resuelto`: Bodega despachó, con el documento de respaldo (y la hoja MSDS si había químicos). */
  async alResolver(tx: Prisma.TransactionClient, event: EventEnvelope): Promise<void> {
    const { pedidoId, archivoRespaldoId, archivoMsdsId } = event.data as Record<string, unknown>;
    const actorId = event.actor?.userId;
    const msds = archivoMsdsId ?? null;
    if (
      !esUuid(pedidoId) ||
      !esUuid(actorId) ||
      !esUuid(archivoRespaldoId) ||
      (msds !== null && !esUuid(msds)) ||
      !(await tx.idUsuario.findUnique({ where: { id: actorId }, select: { id: true } })) ||
      !(await tx.archivoRef.findUnique({
        where: { id: archivoRespaldoId },
        select: { id: true },
      })) ||
      (msds !== null &&
        !(await tx.archivoRef.findUnique({ where: { id: msds as string }, select: { id: true } })))
    ) {
      this.logger.warn(
        `Evento ${event.id}: despacho resuelto con datos o archivos inválidos; se ignora`,
      );
      return;
    }
    const at = new Date(event.occurredAt);
    const realizado = {
      estado: 'realizado' as const,
      realizadoAt: at,
      realizadoPorId: actorId,
      archivoRespaldoId,
      archivoMsdsId: msds as string | null,
      updatedBy: actorId,
    };
    // si la solicitud no llegó antes (eventos fuera de orden), se abre con los datos de quien despachó
    await tx.despacho.upsert({
      where: { pedidoId },
      create: {
        id: uuidv7(),
        pedidoId,
        solicitadoAt: at,
        solicitadoPorId: actorId,
        createdBy: actorId,
        ...realizado,
      },
      update: realizado,
    });
  }

  async listar(f: ListarDespachosDto) {
    const filas = await this.prisma.despacho.findMany({
      where: f.estado ? { estado: f.estado } : {},
      orderBy: { solicitadoAt: 'desc' },
      include: {
        solicitadoPor: { select: { id: true, nombre: true } },
        realizadoPor: { select: { id: true, nombre: true } },
        _count: { select: { movimientos: true } },
      },
    });
    return filas.map(({ _count, ...d }) => ({ ...this.vista(d), movimientos: _count.movimientos }));
  }

  async detalle(id: string) {
    const d = await this.prisma.despacho.findUnique({
      where: { id },
      include: {
        solicitadoPor: { select: { id: true, nombre: true } },
        realizadoPor: { select: { id: true, nombre: true } },
        movimientos: { include: INCLUIR_MOVIMIENTO, orderBy: { secuencia: 'asc' } },
      },
    });
    if (!d) throw new NotFoundException('El despacho no existe');
    const { movimientos, ...resto } = d;
    return { ...this.vista(resto), movimientos: movimientos.map(vistaMovimiento) };
  }

  /** Salida de stock de un artículo que respalda el despacho. Solo mientras el despacho está solicitado. */
  async registrarSalida(id: string, dto: SalidaDespachoDto, actor: ActorInventario) {
    await this.prisma.$transaction((tx) =>
      this.movimientos.registrarSalidaDespacho(
        tx,
        {
          despachoId: id,
          articuloId: dto.articuloId,
          bodegaId: dto.bodegaId,
          cantidad: dto.cantidad,
          observacion: dto.observacion,
        },
        actor,
      ),
    );
    return this.detalle(id);
  }

  private vista(d: {
    id: string;
    pedidoId: string;
    estado: string;
    solicitadoAt: Date;
    solicitadoPor: { id: string; nombre: string };
    realizadoAt: Date | null;
    realizadoPor: { id: string; nombre: string } | null;
    archivoRespaldoId: string | null;
    archivoMsdsId: string | null;
  }) {
    return {
      id: d.id,
      pedidoId: d.pedidoId,
      estado: d.estado,
      solicitadoAt: d.solicitadoAt.toISOString(),
      solicitadoPor: d.solicitadoPor,
      realizadoAt: d.realizadoAt?.toISOString() ?? null,
      realizadoPor: d.realizadoPor,
      archivoRespaldoId: d.archivoRespaldoId,
      archivoMsdsId: d.archivoMsdsId,
    };
  }
}
