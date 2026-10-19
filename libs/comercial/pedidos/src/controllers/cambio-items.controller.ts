import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { Permission } from '@dyn/authz';
import { RequirePermission } from '@dyn/common';
import { CambioItemsService } from '../services/cambio-items.service';

/** Lo que Operaciones necesita para proponer o revisar un cambio de ítems del pedido (sin precios). */
@Controller('comercial/pedidos/:pedidoId/items-para-cambio')
export class CambioItemsController {
  constructor(private readonly cambios: CambioItemsService) {}

  /** `?q=` (2 letras o más) trae además los ítems elegibles de la lista de precios del cliente. */
  @RequirePermission(Permission.PUMPING_CAMBIOS_SOLICITAR, Permission.PUMPING_CAMBIOS_APROBAR)
  @Get()
  itemsParaCambio(@Param('pedidoId', ParseUUIDPipe) pedidoId: string, @Query('q') q?: string) {
    return this.cambios.itemsParaCambio(pedidoId, q);
  }
}
