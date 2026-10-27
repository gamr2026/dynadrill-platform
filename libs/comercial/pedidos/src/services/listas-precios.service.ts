import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { AuthUser } from '@dyn/common';
import { uuidv7 } from '@dyn/utils';
import { CrearListaPreciosDto, ItemsListaQueryDto, ListasPreciosQueryDto } from '../dto/pedidos.dto';
import { Prisma } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';

/** Consulta de listas de precios: de aquí salen los ítems de un pedido. La edición llega con el módulo de facturación. */
@Injectable()
export class ListasPreciosService {
  constructor(private readonly prisma: PrismaService) {}

  async listar(q: ListasPreciosQueryDto) {
    const filas = await this.prisma.listaPrecios.findMany({
      where: {
        ...(q.clienteId ? { clienteId: q.clienteId } : {}),
        ...(q.activa ? { activa: q.activa === 'true' } : {}),
      },
      orderBy: [{ cliente: { nombreFiscal: 'asc' } }, { vigenteDesde: 'desc' }],
      include: { cliente: true, _count: { select: { items: true } } },
    });
    const porTipo = await this.totalesPorTipo(filas.map((l) => l.id));
    return filas.map((l) => ({ ...this.cabecera(l), items: l._count.items, ...porTipo.get(l.id) }));
  }

  /**
   * Alta de la cabecera de una lista: cliente del catálogo, número de contrato y desde cuándo rige. No se repite el contrato de un mismo
   * cliente (lo exige también un índice único). Los ítems no se escriben aquí: llegan con la carga de datos reales.
   */
  async crear(dto: CrearListaPreciosDto, actor: AuthUser) {
    const cliente = await this.prisma.catCliente.findUnique({ where: { id: dto.clienteId } });
    if (!cliente) throw new BadRequestException('El cliente indicado no existe en el catálogo');
    const contrato = dto.numeroContrato.trim();
    if (!contrato) throw new BadRequestException('Indique el número de contrato');
    const repetida = await this.prisma.listaPrecios.findFirst({
      where: { clienteId: dto.clienteId, numeroContrato: { equals: contrato, mode: 'insensitive' } },
      select: { id: true },
    });
    if (repetida) throw new ConflictException('Ese cliente ya tiene una lista de precios con ese número de contrato');
    const id = uuidv7();
    await this.prisma.listaPrecios.create({
      data: {
        id,
        clienteId: dto.clienteId,
        numeroContrato: contrato,
        vigenteDesde: new Date(`${dto.vigenteDesde.slice(0, 10)}T00:00:00.000Z`),
        activa: dto.activa ?? true,
        createdBy: actor.id,
        updatedBy: actor.id,
      },
    });
    return this.detalle(id);
  }

  /** La lista con sus totales por tipo (cantidad de ítems y suma de precios unitarios), sin traer los ítems. */
  async detalle(id: string) {
    const l = await this.prisma.listaPrecios.findUnique({
      where: { id },
      include: { cliente: true, _count: { select: { items: true } } },
    });
    if (!l) throw new NotFoundException('La lista de precios no existe');
    const totales = (await this.totalesPorTipo([id])).get(id);
    return { ...this.cabecera(l), items: l._count.items, ...totales };
  }

  private cabecera(l: {
    id: string;
    clienteId: string | null;
    cliente: { nombreFiscal: string | null; nombreComercial: string } | null;
    numeroContrato: string | null;
    vigenteDesde: Date;
    activa: boolean;
  }) {
    return {
      id: l.id,
      clienteId: l.clienteId,
      clienteNombre: l.cliente ? (l.cliente.nombreFiscal ?? l.cliente.nombreComercial) : null,
      numeroContrato: l.numeroContrato,
      vigenteDesde: l.vigenteDesde.toISOString().slice(0, 10),
      activa: l.activa,
    };
  }

  /** Por lista: cuántos ítems de servicio y de material tiene y cuánto suman sus precios unitarios (no es un total a cobrar). */
  private async totalesPorTipo(listaIds: string[]) {
    const grupos = await this.prisma.listaPreciosItem.groupBy({
      by: ['listaPreciosId', 'tipo'],
      where: { listaPreciosId: { in: listaIds } },
      _count: { _all: true },
      _sum: { precio: true },
    });
    const vacio = () => ({ cantidad: 0, suma: 0 });
    const porLista = new Map<
      string,
      { servicios: ReturnType<typeof vacio>; materiales: ReturnType<typeof vacio> }
    >();
    for (const g of grupos) {
      const t = porLista.get(g.listaPreciosId) ?? { servicios: vacio(), materiales: vacio() };
      const destino = g.tipo === 'Servicio' ? t.servicios : t.materiales;
      destino.cantidad = g._count._all;
      destino.suma = Math.round(Number(g._sum.precio ?? 0) * 100) / 100;
      porLista.set(g.listaPreciosId, t);
    }
    return porLista;
  }

  /**
   * Ítems elegibles para un pedido: los de las listas ACTIVAS del cliente (si un código está en varias, gana la lista
   * vigente más reciente), con búsqueda y paginación. Cada ítem trae el `listaPreciosItemId` que el pedido guarda.
   */
  async itemsDeCliente(clienteId: string, q: ItemsListaQueryDto) {
    if (!clienteId) throw new BadRequestException('Indique el cliente');
    const page = q.page ?? 1;
    const limit = q.limit ?? 50;
    const where: Prisma.ListaPreciosItemWhereInput = {
      listaPrecios: { clienteId, activa: true },
      ...(q.tipo ? { tipo: q.tipo } : {}),
      ...(q.q
        ? {
            OR: [
              { codigo: { contains: q.q.trim(), mode: 'insensitive' } },
              { descripcion: { contains: q.q.trim(), mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const filas = await this.prisma.listaPreciosItem.findMany({
      where,
      orderBy: [{ codigo: 'asc' }, { listaPrecios: { vigenteDesde: 'desc' } }],
      include: {
        listaPrecios: { select: { id: true, numeroContrato: true } },
        unidadMedida: { select: { nombre: true } },
      },
    });
    // un código solo una vez (el de la lista más reciente, que ya viene primero)
    const unicos = new Map<string, (typeof filas)[number]>();
    for (const f of filas) if (!unicos.has(f.codigo)) unicos.set(f.codigo, f);
    const todos = [...unicos.values()];
    return {
      total: todos.length,
      page,
      limit,
      items: todos.slice((page - 1) * limit, page * limit).map((f) => ({
        listaPreciosItemId: f.id,
        listaPreciosId: f.listaPrecios.id,
        numeroContrato: f.listaPrecios.numeroContrato,
        codigo: f.codigo,
        descripcion: f.descripcion,
        unidad: f.unidadMedida.nombre,
        unidadMedidaId: f.unidadMedidaId,
        precio: Number(f.precio),
        tipo: f.tipo,
      })),
    };
  }

  async items(listaId: string, q: ItemsListaQueryDto) {
    const existe = await this.prisma.listaPrecios.findUnique({
      where: { id: listaId },
      select: { id: true },
    });
    if (!existe) throw new NotFoundException('La lista de precios no existe');
    const page = q.page ?? 1;
    const limit = q.limit ?? 50;
    const where: Prisma.ListaPreciosItemWhereInput = {
      listaPreciosId: listaId,
      ...(q.tipo ? { tipo: q.tipo } : {}),
      ...(q.q
        ? {
            OR: [
              { codigo: { contains: q.q.trim(), mode: 'insensitive' } },
              { descripcion: { contains: q.q.trim(), mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [total, filas] = await Promise.all([
      this.prisma.listaPreciosItem.count({ where }),
      this.prisma.listaPreciosItem.findMany({
        where,
        orderBy: { codigo: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
        include: { unidadMedida: { select: { nombre: true } } },
      }),
    ]);
    return {
      total,
      page,
      limit,
      items: filas.map((f) => ({
        id: f.id,
        codigo: f.codigo,
        descripcion: f.descripcion,
        unidad: f.unidadMedida.nombre,
        unidadMedidaId: f.unidadMedidaId,
        precio: Number(f.precio),
        tipo: f.tipo,
      })),
    };
  }
}
