import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { AuthUser } from '@dyn/common';
import type { ItemPedidoDto } from '../dto/pedidos.dto';
import { PrismaService } from '../prisma/prisma.service';
import { PedidosService } from './pedidos.service';
import { PrefacturasService } from './prefacturas.service';

/**
 * Cambio de ítems del pedido que propone el Operador de Pumping y aprueba su Supervisor (contrato 4.13). Comercial expone los ítems
 * actuales y los elegibles de la lista de precios del cliente (sin precios: no los necesita quien propone) y aplica el cambio ya
 * aprobado; si el pedido tiene una prefactura recién generada (aún no enviada al cliente), la recalcula.
 */
@Injectable()
export class CambioItemsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pedidos: PedidosService,
    private readonly prefacturas: PrefacturasService,
  ) {}

  /** Los ítems del pedido tal como están y, si se escribe un texto (2 letras o más), hasta 30 ítems elegibles de la lista del cliente. */
  async itemsParaCambio(pedidoId: string, texto?: string) {
    const pedido = await this.prisma.pedido.findUnique({
      where: { id: pedidoId },
      select: { clienteId: true, items: { orderBy: { orden: 'asc' } } },
    });
    if (!pedido) throw new NotFoundException('El pedido no existe');
    const q = texto?.trim();
    const opciones =
      q && q.length >= 2 && pedido.clienteId
        ? await this.prisma.listaPreciosItem.findMany({
            where: {
              listaPrecios: { clienteId: pedido.clienteId, activa: true },
              OR: [
                { codigo: { contains: q, mode: 'insensitive' } },
                { descripcion: { contains: q, mode: 'insensitive' } },
              ],
            },
            orderBy: { codigo: 'asc' },
            take: 30,
          })
        : [];
    return {
      actuales: pedido.items.map((i) => ({
        listaPreciosItemId: i.listaPreciosItemId,
        codigo: i.codigo,
        descripcion: i.descripcion,
        unidad: i.unidad,
        cantidad: Number(i.cantidad),
        descuentoPct: i.descuentoPct === null ? null : Number(i.descuentoPct),
        tipoLinea: i.tipoLinea,
      })),
      opciones: opciones.map((o) => ({
        listaPreciosItemId: o.id,
        codigo: o.codigo,
        descripcion: o.descripcion,
        unidad: o.unidad,
        tipo: o.tipo,
      })),
    };
  }

  /** Aplica el cambio aprobado y recalcula la prefactura si todavía no salió al cliente. Lanza un error de negocio si no se puede. */
  async aplicar(pedidoId: string, items: ItemPedidoDto[], actor: AuthUser): Promise<void> {
    const ctx = { actor, token: '' };
    await this.pedidos.aplicarCambioDeItems(pedidoId, items, ctx);
    const vigente = await this.prisma.prefactura.findFirst({
      where: { pedidoId, estado: 'generada' },
      select: { id: true },
    });
    if (vigente) {
      try {
        await this.prefacturas.recalcular(vigente.id, ctx);
      } catch (e) {
        // los ítems ya cambiaron: la prefactura se puede recalcular después desde Facturación
        if (!(e instanceof ConflictException)) throw e;
      }
    }
  }
}
