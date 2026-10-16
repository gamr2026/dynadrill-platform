import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ItemsListaQueryDto, ListasPreciosQueryDto } from '../dto/pedidos.dto';
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
    return filas.map((l) => ({
      id: l.id,
      clienteId: l.clienteId,
      clienteNombre: l.cliente ? (l.cliente.nombreFiscal ?? l.cliente.nombreComercial) : null,
      numeroContrato: l.numeroContrato,
      vigenteDesde: l.vigenteDesde.toISOString().slice(0, 10),
      activa: l.activa,
      items: l._count.items,
    }));
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
      include: { listaPrecios: { select: { id: true, numeroContrato: true } } },
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
        unidad: f.unidad,
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
        unidad: f.unidad,
        precio: Number(f.precio),
        tipo: f.tipo,
      })),
    };
  }
}
