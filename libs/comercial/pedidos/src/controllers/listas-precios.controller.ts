import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { Permission } from '@dyn/authz';
import { RequirePermission } from '@dyn/common';
import { ItemsListaQueryDto, ListasPreciosQueryDto } from '../dto/pedidos.dto';
import { ListasPreciosService } from '../services/listas-precios.service';

/** Consulta de listas de precios. Los ítems de un pedido salen siempre de aquí. */
@Controller('comercial/listas-precios')
export class ListasPreciosController {
  constructor(private readonly listas: ListasPreciosService) {}

  @RequirePermission(Permission.LISTAS_PRECIOS_VER)
  @Get()
  listar(@Query() q: ListasPreciosQueryDto) {
    return this.listas.listar(q);
  }

  /** Ítems elegibles para un pedido de ese cliente: `?clienteId=<uuid>&q=&tipo=&page=&limit=`. */
  @RequirePermission(Permission.LISTAS_PRECIOS_VER)
  @Get('items')
  itemsDeCliente(@Query('clienteId') clienteId: string, @Query() q: ItemsListaQueryDto) {
    return this.listas.itemsDeCliente(clienteId, q);
  }

  @RequirePermission(Permission.LISTAS_PRECIOS_VER)
  @Get(':id')
  detalle(@Param('id', ParseUUIDPipe) id: string) {
    return this.listas.detalle(id);
  }

  @RequirePermission(Permission.LISTAS_PRECIOS_VER)
  @Get(':id/items')
  items(@Param('id', ParseUUIDPipe) id: string, @Query() q: ItemsListaQueryDto) {
    return this.listas.items(id, q);
  }
}
