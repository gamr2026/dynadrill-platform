import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { currentTraceparent } from '@dyn/common';
import { EventBus, type EventEnvelope } from '@dyn/messaging';
import { uuidv7 } from '@dyn/utils';
import type {
  ListarDespachosDto,
  RealizarDespachoDto,
  RechazarDespachoDto,
  SalidaDespachoDto,
} from '../dto/inventario.dto';
import type { Prisma, TipoItemDespacho } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  INCLUIR_MOVIMIENTO,
  MovimientosService,
  vistaMovimiento,
  type ActorInventario,
} from './movimientos.service';

export const EVENTO_DESPACHO_REALIZADO = 'operaciones.inventario.despacho.realizado';
export const EVENTO_DESPACHO_RECHAZADO = 'operaciones.inventario.despacho.rechazado';

const esUuid = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const esFecha = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const texto = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const TIPOS: readonly string[] = ['material', 'herramienta'];

/** Un ítem tal como lo publica Comercial en `comercial.despacho.solicitado`. */
interface ItemSolicitado {
  listaPreciosItemId?: string | null;
  codigo: string;
  descripcion: string;
  cantidad: number;
  unidadMedidaId: string;
  tipo: TipoItemDespacho;
}

const INCLUIR = {
  solicitadoPor: { select: { id: true, nombre: true } },
  realizadoPor: { select: { id: true, nombre: true } },
  rechazadoPor: { select: { id: true, nombre: true } },
  bodega: { select: { id: true, nombre: true } },
  cliente: { select: { id: true, nombreComercial: true, nombreFiscal: true } },
  items: {
    orderBy: { orden: 'asc' },
    include: {
      unidadMedida: { select: { nombre: true, simbolo: true } },
      articulo: { select: { id: true, codigo: true, nombre: true } },
    },
  },
} satisfies Prisma.DespachoInclude;
type DespachoConDatos = Prisma.DespachoGetPayload<{ include: typeof INCLUIR }>;

/**
 * Despachos a bodega (CM-5). Inventario es el dueño: Comercial pide el despacho con la prefactura generada
 * (`comercial.despacho.solicitado`, con la bodega, la fecha requerida, la nota y los ítems) y Bodega lo resuelve aquí: lo despacha
 * con su documento de respaldo (y la hoja MSDS si hay químicos) o lo rechaza con motivo. El resultado vuelve a Comercial
 * (`operaciones.inventario.despacho.realizado|rechazado`), que devuelve el pedido a la etapa de prefactura. Mientras está pendiente
 * se registran las salidas de stock que lo respaldan. Una solicitud resuelta no cambia (la base lo impide).
 */
@Injectable()
export class DespachosService {
  private readonly logger = new Logger(DespachosService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly movimientos: MovimientosService,
    private readonly bus: EventBus,
  ) {}

  /** `comercial.despacho.solicitado`: abre la solicitud con sus ítems. Lo que no se entiende se registra y se ignora. */
  async alSolicitar(tx: Prisma.TransactionClient, event: EventEnvelope): Promise<void> {
    const d = event.data as Record<string, unknown>;
    const actorId = event.actor?.userId;
    const items = Array.isArray(d['items']) ? (d['items'] as ItemSolicitado[]) : [];
    const valido =
      esUuid(d['pedidoId']) &&
      esUuid(d['bodegaId']) &&
      esFecha(d['fechaRequerida']) &&
      (d['clienteId'] == null || esUuid(d['clienteId'])) &&
      esUuid(actorId) &&
      items.length > 0 &&
      items.every(
        (i) =>
          texto(i.codigo) &&
          texto(i.descripcion) &&
          Number(i.cantidad) > 0 &&
          esUuid(i.unidadMedidaId) &&
          TIPOS.includes(i.tipo) &&
          (i.listaPreciosItemId == null || esUuid(i.listaPreciosItemId)),
      );
    if (!valido) {
      this.logger.warn(
        `Evento ${event.id}: solicitud de despacho incompleta o inválida; se ignora`,
      );
      return;
    }
    const pedidoId = d['pedidoId'] as string;
    const pendiente = await tx.despacho.findFirst({
      where: { pedidoId, estado: 'solicitado' },
      select: { numero: true },
    });
    if (pendiente) {
      this.logger.warn(
        `Evento ${event.id}: el pedido ${pedidoId} ya tiene pendiente el despacho ${pendiente.numero}; se ignora`,
      );
      return;
    }
    const id = uuidv7();
    await tx.despacho.create({
      data: {
        id,
        pedidoId,
        pedidoCodigo: texto(d['pedidoCodigo']),
        clienteId: (d['clienteId'] as string | null) ?? null,
        bodegaId: d['bodegaId'] as string,
        fechaRequerida: new Date(`${d['fechaRequerida'] as string}T00:00:00.000Z`),
        notaSolicitud: texto(d['nota']),
        estado: 'solicitado',
        solicitadoAt: new Date(event.occurredAt),
        solicitadoPorId: actorId as string,
        createdBy: actorId as string,
        updatedBy: actorId as string,
      },
    });
    const articulos = await this.articulosPorCodigo(
      tx,
      items.map((i) => i.codigo.trim()),
    );
    await tx.despachoItem.createMany({
      data: items.map((i, k) => ({
        id: uuidv7(),
        despachoId: id,
        orden: k + 1,
        listaPreciosItemId: i.listaPreciosItemId ?? null,
        codigo: i.codigo.trim(),
        descripcion: i.descripcion.trim(),
        cantidad: Number(i.cantidad),
        unidadMedidaId: i.unidadMedidaId,
        tipo: i.tipo,
        articuloId: articulos.get(i.codigo.trim().toLowerCase()) ?? null,
        createdBy: actorId as string,
      })),
    });
  }

  async listar(f: ListarDespachosDto) {
    const filas = await this.prisma.despacho.findMany({
      where: {
        ...(f.estado ? { estado: f.estado } : {}),
        ...(f.pedidoId ? { pedidoId: f.pedidoId } : {}),
      },
      orderBy: { solicitadoAt: 'desc' },
      include: { ...INCLUIR, _count: { select: { movimientos: true } } },
    });
    return filas.map(({ _count, ...d }) => ({ ...this.vista(d), movimientos: _count.movimientos }));
  }

  async detalle(id: string) {
    const d = await this.prisma.despacho.findUnique({
      where: { id },
      include: {
        ...INCLUIR,
        movimientos: { include: INCLUIR_MOVIMIENTO, orderBy: { secuencia: 'asc' } },
      },
    });
    if (!d) throw new NotFoundException('El despacho no existe');
    const { movimientos, ...resto } = d;
    return { ...this.vista(resto), movimientos: movimientos.map(vistaMovimiento) };
  }

  /** Salida de stock de un artículo que respalda el despacho. Solo mientras el despacho está pendiente. */
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

  /** Bodega despacha: documento de respaldo obligatorio, hoja MSDS si hay químicos, y la referencia de AS2 si la tiene. */
  async realizar(id: string, dto: RealizarDespachoDto, actor: ActorInventario) {
    await this.prisma.$transaction(async (tx) => {
      const d = await this.pendiente(tx, id);
      const ids = [dto.archivoRespaldoId, ...(dto.archivoMsdsId ? [dto.archivoMsdsId] : [])];
      const existen = await tx.archivoRef.count({ where: { id: { in: ids } } });
      if (existen !== new Set(ids).size) {
        throw new BadRequestException('El documento de respaldo o la hoja MSDS no existen');
      }
      await tx.despacho.update({
        where: { id },
        data: {
          estado: 'realizado',
          realizadoAt: new Date(),
          realizadoPorId: actor.id,
          archivoRespaldoId: dto.archivoRespaldoId,
          archivoMsdsId: dto.archivoMsdsId ?? null,
          referenciaAs2: texto(dto.referenciaAs2),
          notaBodega: texto(dto.notaBodega),
          updatedBy: actor.id,
        },
      });
      await this.publicar(tx, EVENTO_DESPACHO_REALIZADO, d, actor, {
        archivoRespaldoId: dto.archivoRespaldoId,
        archivoMsdsId: dto.archivoMsdsId ?? null,
      });
    });
    return this.detalle(id);
  }

  /** Bodega rechaza (p. ej. sin stock): con motivo. El pedido vuelve a Facturación. */
  async rechazar(id: string, dto: RechazarDespachoDto, actor: ActorInventario) {
    const motivo = dto.motivo.trim();
    if (!motivo) throw new BadRequestException('Escriba el motivo del rechazo');
    await this.prisma.$transaction(async (tx) => {
      const d = await this.pendiente(tx, id);
      const salidas = await tx.movimiento.count({ where: { despachoId: id } });
      if (salidas > 0) {
        throw new ConflictException(
          'El despacho ya tiene salidas de stock registradas: no se puede rechazar',
        );
      }
      await tx.despacho.update({
        where: { id },
        data: {
          estado: 'rechazado',
          rechazadoAt: new Date(),
          rechazadoPorId: actor.id,
          motivoRechazo: motivo,
          notaBodega: texto(dto.notaBodega),
          updatedBy: actor.id,
        },
      });
      await this.publicar(tx, EVENTO_DESPACHO_RECHAZADO, d, actor, { motivo });
    });
    return this.detalle(id);
  }

  private async pendiente(tx: Prisma.TransactionClient, id: string) {
    const d = await tx.despacho.findUnique({
      where: { id },
      select: { id: true, numero: true, pedidoId: true, estado: true },
    });
    if (!d) throw new NotFoundException('El despacho no existe');
    if (d.estado !== 'solicitado') {
      throw new ConflictException({
        message: `El despacho ${d.numero} ya fue ${d.estado === 'realizado' ? 'despachado' : 'rechazado'}`,
        code: 'DESPACHO_RESUELTO',
      });
    }
    return d;
  }

  private async publicar(
    tx: Prisma.TransactionClient,
    type: string,
    d: { id: string; numero: number; pedidoId: string },
    actor: ActorInventario,
    extra: Record<string, unknown>,
  ) {
    await this.bus.publish(
      tx,
      this.bus.create({
        type,
        subject: { type: 'inventario_despacho', id: d.id },
        data: { despachoId: d.id, numero: d.numero, pedidoId: d.pedidoId, ...extra },
        actor: { userId: actor.id, role: actor.roleCode },
        traceparent: currentTraceparent(),
      }),
    );
  }

  /** Artículo de Inventario por código (el principal, uno alterno o una equivalencia), sin distinguir mayúsculas. */
  private async articulosPorCodigo(
    tx: Prisma.TransactionClient,
    codigos: string[],
  ): Promise<Map<string, string>> {
    const unicos = [...new Set(codigos.map((c) => c.toLowerCase()))];
    const filas = await tx.$queryRaw<{ codigo: string; id: string }[]>`
      SELECT lower(a.codigo) AS codigo, a.id::text AS id FROM inventario.articulo a WHERE lower(a.codigo) = ANY(${unicos})
      UNION SELECT lower(c.codigo), c.articulo_id::text FROM inventario.articulo_codigo c WHERE lower(c.codigo) = ANY(${unicos})
      UNION SELECT lower(e.codigo), e.articulo_id::text FROM inventario.articulo_equivalencia e WHERE lower(e.codigo) = ANY(${unicos})`;
    const m = new Map<string, string>();
    for (const f of filas) if (!m.has(f.codigo)) m.set(f.codigo, f.id);
    return m;
  }

  private vista(d: DespachoConDatos) {
    return {
      id: d.id,
      numero: d.numero,
      pedidoId: d.pedidoId,
      pedidoCodigo: d.pedidoCodigo,
      cliente: d.cliente
        ? { id: d.cliente.id, nombre: d.cliente.nombreFiscal ?? d.cliente.nombreComercial }
        : null,
      bodega: d.bodega,
      fechaRequerida: d.fechaRequerida.toISOString().slice(0, 10),
      nota: d.notaSolicitud,
      estado: d.estado,
      solicitadoAt: d.solicitadoAt.toISOString(),
      solicitadoPor: d.solicitadoPor,
      realizadoAt: d.realizadoAt?.toISOString() ?? null,
      realizadoPor: d.realizadoPor,
      archivoRespaldoId: d.archivoRespaldoId,
      archivoMsdsId: d.archivoMsdsId,
      referenciaAs2: d.referenciaAs2,
      notaBodega: d.notaBodega,
      rechazadoAt: d.rechazadoAt?.toISOString() ?? null,
      rechazadoPor: d.rechazadoPor,
      motivoRechazo: d.motivoRechazo,
      items: d.items.map((i) => ({
        orden: i.orden,
        listaPreciosItemId: i.listaPreciosItemId,
        codigo: i.codigo,
        descripcion: i.descripcion,
        cantidad: Number(i.cantidad),
        unidad: i.unidadMedida.nombre,
        unidadMedidaId: i.unidadMedidaId,
        tipo: i.tipo,
        articulo: i.articulo,
      })),
    };
  }
}
