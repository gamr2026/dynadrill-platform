import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { currentTraceparent } from '@dyn/common';
import { EventBus } from '@dyn/messaging';
import { uuidv7 } from '@dyn/utils';
import type {
  ActualizarArticuloDto,
  CrearArticuloDto,
  ListarArticulosDto,
} from '../dto/inventario.dto';
import type { Prisma } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import { saldosPorBodega } from './kardex';

const INCLUIR = {
  categoria: true,
  subcategoria: true,
  unidadStock: true,
  codigos: true,
  equivalencias: true,
} satisfies Prisma.ArticuloInclude;

/** Quién hace el cambio: su id (auditoría) y su rol (el evento lo lleva). */
export interface ActorCambio {
  id: string;
  roleCode: string;
}

/** Evento con el que QHSE (otro contenedor) recibe los artículos que se entregan a una persona. */
export const EVENTO_ARTICULO_EPI = 'operaciones.inventario.articulo_epi_actualizado';

type ArticuloConNombres = Prisma.ArticuloGetPayload<{ include: typeof INCLUIR }>;

const num = (d: Prisma.Decimal | null) => (d === null ? null : Number(d));

/** Lo que devuelve la API de un artículo: nombres por JOIN, números (no textos decimales) y el stock calculado. */
function vista(a: ArticuloConNombres, stockActual: number) {
  const codigo = (tipo: 'alterno' | 'comercial' | 'barras') =>
    a.codigos.find((c) => c.tipo === tipo)?.codigo ?? null;
  return {
    id: a.id,
    codigo: a.codigo,
    nombre: a.nombre,
    nombreComercial: a.nombreComercial,
    categoria: {
      id: a.categoria.id,
      nombre: a.categoria.nombre,
      esQuimica: a.categoria.esQuimica,
      llevaPartes: a.categoria.llevaPartes,
      esRepuesto: a.categoria.esRepuesto,
    },
    subcategoria: a.subcategoria ? { id: a.subcategoria.id, nombre: a.subcategoria.nombre } : null,
    unidadStock: {
      id: a.unidadStock.id,
      nombre: a.unidadStock.nombre,
      simbolo: a.unidadStock.simbolo,
    },
    codigos: {
      alterno: codigo('alterno'),
      comercial: codigo('comercial'),
      barras: codigo('barras'),
    },
    entregaPersonal: a.entregaPersonal,
    tipoTalla: a.tipoTalla,
    equivalencias: a.equivalencias.map((e) => ({ codigo: e.codigo, motivo: e.motivo })),
    nota: a.nota,
    informacionAdicional: a.informacionAdicional,
    costoUnitario: num(a.costoUnitario),
    descuentoSugerido: num(a.descuentoSugerido),
    activo: a.activo,
    stockActual,
  };
}

const TIPOS_CODIGO = ['alterno', 'comercial', 'barras'] as const;

@Injectable()
export class ArticulosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: EventBus,
  ) {}

  /** Stock de todos los artículos: el último saldo de cada bodega, sumado. Nunca se guarda. */
  private async stockPorArticulo(): Promise<Map<string, number>> {
    const filas = await this.prisma.$queryRaw<
      Array<{ articulo_id: string; stock: Prisma.Decimal }>
    >`
      SELECT articulo_id, SUM(saldo) AS stock
        FROM (SELECT DISTINCT ON (articulo_id, bodega_id) articulo_id, saldo_resultante AS saldo
                FROM inventario.movimiento
               ORDER BY articulo_id, bodega_id, secuencia DESC) ultimos
       GROUP BY articulo_id`;
    return new Map(filas.map((f) => [f.articulo_id, Number(f.stock)]));
  }

  async listar(f: ListarArticulosDto) {
    const q = f.q?.trim();
    const where: Prisma.ArticuloWhereInput = {
      ...(f.categoriaId ? { categoriaId: f.categoriaId } : {}),
      ...(f.subcategoriaId ? { subcategoriaId: f.subcategoriaId } : {}),
      ...(f.activo !== undefined ? { activo: f.activo } : {}),
      ...(f.quimicos ? { categoria: { esQuimica: true } } : {}),
      ...(f.repuestos ? { categoria: { esRepuesto: true } } : {}),
      ...(q
        ? {
            OR: [
              { codigo: { contains: q, mode: 'insensitive' } },
              { nombre: { contains: q, mode: 'insensitive' } },
              { nombreComercial: { contains: q, mode: 'insensitive' } },
              { codigos: { some: { codigo: { contains: q, mode: 'insensitive' } } } },
            ],
          }
        : {}),
    };
    const [articulos, stock] = await Promise.all([
      this.prisma.articulo.findMany({ where, include: INCLUIR, orderBy: { codigo: 'asc' } }),
      this.stockPorArticulo(),
    ]);
    const todos = articulos.map((a) => vista(a, stock.get(a.id) ?? 0));
    return f.conStock ? todos.filter((a) => a.stockActual > 0) : todos;
  }

  /**
   * Selector de repuestos de Mantenimiento: artículos activos de las categorías de repuestos que coinciden con el texto, cada uno
   * con su existencia por bodega (solo las bodegas con saldo). Devuelve pocos resultados a propósito: se busca escribiendo.
   */
  async repuestosDisponibles(texto: string | undefined) {
    const q = texto?.trim();
    if (!q || q.length < 2) return [];
    return this.disponiblesPorBodega({ esRepuesto: true }, q, false);
  }

  /**
   * Selector de químicos para la asignación de Pumping: artículos activos de las categorías de químicos **con existencia**, cada uno con
   * su saldo por bodega. El texto es opcional (la lista de químicos es corta).
   */
  async quimicosDisponibles(texto: string | undefined) {
    return this.disponiblesPorBodega({ esQuimica: true }, texto?.trim() ?? '', true);
  }

  private async disponiblesPorBodega(
    categoria: Prisma.CategoriaArticuloWhereInput,
    q: string,
    soloConStock: boolean,
  ) {
    const articulos = await this.prisma.articulo.findMany({
      where: {
        activo: true,
        categoria,
        ...(q
          ? {
              OR: [
                { codigo: { contains: q, mode: 'insensitive' } },
                { nombre: { contains: q, mode: 'insensitive' } },
                { nombreComercial: { contains: q, mode: 'insensitive' } },
                { codigos: { some: { codigo: { contains: q, mode: 'insensitive' } } } },
              ],
            }
          : {}),
      },
      include: { unidadStock: true },
      orderBy: { codigo: 'asc' },
      take: 200,
    });
    const filas = [];
    for (const a of articulos) {
      const saldos = (await saldosPorBodega(this.prisma, a.id)).filter((s) => s.saldo > 0);
      if (soloConStock && saldos.length === 0) continue;
      if (filas.length >= 30) break;
      const bodegas = await this.prisma.catBodega.findMany({
        where: { id: { in: saldos.map((s) => s.bodegaId) } },
      });
      filas.push({
        id: a.id,
        codigo: a.codigo,
        nombre: a.nombre,
        unidad: a.unidadStock.simbolo,
        stockActual: saldos.reduce((t, s) => t + s.saldo, 0),
        porBodega: saldos.map((s) => ({
          bodegaId: s.bodegaId,
          bodega: bodegas.find((b) => b.id === s.bodegaId)?.nombre ?? '',
          stock: s.saldo,
        })),
      });
    }
    return filas;
  }

  async detalle(id: string) {
    const a = await this.prisma.articulo.findUnique({ where: { id }, include: INCLUIR });
    if (!a) throw new NotFoundException('El artículo no existe');
    const porBodega = await saldosPorBodega(this.prisma, id);
    const bodegas = await this.prisma.catBodega.findMany({
      where: { id: { in: porBodega.map((s) => s.bodegaId) } },
    });
    const stockPorBodega = porBodega
      .map((s) => ({
        bodegaId: s.bodegaId,
        bodega: bodegas.find((b) => b.id === s.bodegaId)?.nombre ?? '',
        stock: s.saldo,
      }))
      .sort((x, y) => x.bodega.localeCompare(y.bodega));
    return {
      ...vista(
        a,
        stockPorBodega.reduce((t, s) => t + s.stock, 0),
      ),
      stockPorBodega,
    };
  }

  async crear(dto: CrearArticuloDto, actor: ActorCambio) {
    const actorId = actor.id;
    const codigo = dto.codigo.trim();
    this.validarEntrega(dto.entregaPersonal ?? false, dto.tipoTalla ?? null);
    await this.validarClasificacion(dto.categoriaId, dto.subcategoriaId ?? null, dto.unidadStockId);
    if (await this.prisma.articulo.findUnique({ where: { codigo }, select: { id: true } })) {
      throw new ConflictException({
        message: `Ya existe un artículo con el código ${codigo}`,
        code: 'CODIGO_DUPLICADO',
      });
    }
    const id = uuidv7();
    await this.prisma.$transaction(async (tx) => {
      await tx.articulo.create({
        data: {
          id,
          codigo,
          nombre: dto.nombre.trim(),
          nombreComercial: dto.nombreComercial?.trim() || null,
          categoriaId: dto.categoriaId,
          subcategoriaId: dto.subcategoriaId ?? null,
          unidadStockId: dto.unidadStockId,
          nota: dto.nota?.trim() || null,
          informacionAdicional: dto.informacionAdicional?.trim() || null,
          costoUnitario: dto.costoUnitario ?? null,
          descuentoSugerido: dto.descuentoSugerido ?? null,
          entregaPersonal: dto.entregaPersonal ?? false,
          tipoTalla: dto.tipoTalla ?? null,
          activo: dto.activo ?? true,
          createdBy: actorId,
          updatedBy: actorId,
        },
      });
      await this.guardarCodigos(tx, id, dto.codigos, actorId);
      if (dto.entregaPersonal) await this.publicarEpi(tx, id, actor);
    });
    return this.detalle(id);
  }

  async actualizar(id: string, dto: ActualizarArticuloDto, actor: ActorCambio) {
    const actorId = actor.id;
    const actual = await this.prisma.articulo.findUnique({ where: { id } });
    if (!actual) throw new NotFoundException('El artículo no existe');
    const entregaPersonal = dto.entregaPersonal ?? actual.entregaPersonal;
    // `null` explícito quita la talla; si deja de entregarse a una persona, tampoco lleva talla
    const tipoTalla = !entregaPersonal
      ? null
      : dto.tipoTalla !== undefined
        ? dto.tipoTalla
        : actual.tipoTalla;
    this.validarEntrega(entregaPersonal, tipoTalla);
    const categoriaId = dto.categoriaId ?? actual.categoriaId;
    // `null` explícito quita la subcategoría; si cambia la categoría y no se indica otra subcategoría, la anterior deja de valer
    const pedida = dto.subcategoriaId as string | null | undefined;
    const subcategoriaId =
      pedida !== undefined
        ? pedida
        : categoriaId === actual.categoriaId
          ? actual.subcategoriaId
          : null;
    await this.validarClasificacion(
      categoriaId,
      subcategoriaId,
      dto.unidadStockId ?? actual.unidadStockId,
    );
    await this.prisma.$transaction(async (tx) => {
      await tx.articulo.update({
        where: { id },
        data: {
          ...(dto.nombre !== undefined ? { nombre: dto.nombre.trim() } : {}),
          ...(dto.nombreComercial !== undefined
            ? { nombreComercial: dto.nombreComercial?.trim() || null }
            : {}),
          categoriaId,
          subcategoriaId,
          ...(dto.unidadStockId !== undefined ? { unidadStockId: dto.unidadStockId } : {}),
          ...(dto.nota !== undefined ? { nota: dto.nota?.trim() || null } : {}),
          ...(dto.informacionAdicional !== undefined
            ? { informacionAdicional: dto.informacionAdicional?.trim() || null }
            : {}),
          ...(dto.costoUnitario !== undefined ? { costoUnitario: dto.costoUnitario } : {}),
          ...(dto.descuentoSugerido !== undefined
            ? { descuentoSugerido: dto.descuentoSugerido }
            : {}),
          ...(dto.activo !== undefined ? { activo: dto.activo } : {}),
          entregaPersonal,
          tipoTalla,
          updatedBy: actorId,
        },
      });
      await this.guardarCodigos(tx, id, dto.codigos, actorId);
      // si dejó de entregarse a una persona también se avisa: QHSE lo desactiva
      if (entregaPersonal || actual.entregaPersonal) await this.publicarEpi(tx, id, actor);
    });
    return this.detalle(id);
  }

  /** Solo un artículo que se entrega a una persona lleva talla (la base lo garantiza también con un CHECK). */
  private validarEntrega(entregaPersonal: boolean, tipoTalla: string | null) {
    if (tipoTalla && !entregaPersonal) {
      throw new ConflictException({
        message: 'Solo un artículo que se entrega a una persona lleva tipo de talla',
        code: 'TALLA_SIN_ENTREGA',
      });
    }
  }

  /** Publica el artículo para QHSE, en la transacción de quien cambia (outbox). Lleva solo lo que QHSE necesita. */
  private async publicarEpi(tx: Prisma.TransactionClient, articuloId: string, actor: ActorCambio) {
    const a = await tx.articulo.findUniqueOrThrow({ where: { id: articuloId } });
    await this.bus.publish(
      tx,
      this.bus.create({
        type: EVENTO_ARTICULO_EPI,
        subject: { type: 'inventario_articulo', id: a.id },
        data: {
          articuloId: a.id,
          codigo: a.codigo,
          nombre: a.nombre,
          tipoTalla: a.tipoTalla,
          entregaPersonal: a.entregaPersonal,
          activo: a.activo,
        },
        actor: { userId: actor.id, role: actor.roleCode },
        traceparent: currentTraceparent(),
      }),
    );
  }

  /** Vuelve a publicar todos los artículos que se entregan a una persona (carga inicial o recuperación de QHSE). */
  async republicarEpi(actor: ActorCambio): Promise<{ publicados: number }> {
    const ids = await this.prisma.articulo.findMany({
      where: { entregaPersonal: true },
      select: { id: true },
      orderBy: { codigo: 'asc' },
    });
    await this.prisma.$transaction(async (tx) => {
      for (const { id } of ids) await this.publicarEpi(tx, id, actor);
    });
    return { publicados: ids.length };
  }

  private async validarClasificacion(
    categoriaId: string,
    subcategoriaId: string | null,
    unidadStockId: string,
  ) {
    const categoria = await this.prisma.categoriaArticulo.findUnique({
      where: { id: categoriaId },
    });
    if (!categoria || !categoria.activo) {
      throw new ConflictException({
        message: 'La categoría no existe o está inactiva',
        code: 'CATEGORIA_INVALIDA',
      });
    }
    if (subcategoriaId) {
      const sub = await this.prisma.subcategoriaArticulo.findUnique({
        where: { id: subcategoriaId },
      });
      if (!sub || !sub.activo || sub.categoriaId !== categoriaId) {
        throw new ConflictException({
          message: 'La subcategoría no existe, está inactiva o no pertenece a la categoría',
          code: 'SUBCATEGORIA_INVALIDA',
        });
      }
    }
    const unidad = await this.prisma.unidadStock.findUnique({ where: { id: unidadStockId } });
    if (!unidad || !unidad.activo) {
      throw new ConflictException({
        message: 'La unidad de stock no existe o está inactiva',
        code: 'UNIDAD_INVALIDA',
      });
    }
  }

  /** Un código por tipo: con texto lo crea o lo cambia; con cadena vacía lo quita; sin indicar, lo deja. */
  private async guardarCodigos(
    tx: Prisma.TransactionClient,
    articuloId: string,
    codigos: Partial<Record<(typeof TIPOS_CODIGO)[number], string>> | undefined,
    actorId: string,
  ) {
    if (!codigos) return;
    for (const tipo of TIPOS_CODIGO) {
      const valor = codigos[tipo];
      if (valor === undefined) continue;
      const texto = valor.trim();
      if (!texto) {
        await tx.articuloCodigo.deleteMany({ where: { articuloId, tipo } });
      } else {
        await tx.articuloCodigo.upsert({
          where: { articuloId_tipo: { articuloId, tipo } },
          create: {
            id: uuidv7(),
            articuloId,
            tipo,
            codigo: texto,
            createdBy: actorId,
            updatedBy: actorId,
          },
          update: { codigo: texto, updatedBy: actorId },
        });
      }
    }
  }
}
