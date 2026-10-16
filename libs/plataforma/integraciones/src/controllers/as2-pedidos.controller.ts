import { Controller, Get, Param, ParseIntPipe, Query } from '@nestjs/common';
import { Permission } from '@dyn/authz';
import { RequirePermission } from '@dyn/common';
import { As2PedidosQueryDto } from '../dto/as2-pedidos.dto';
import { As2PedidosService } from '../services/as2-pedidos.service';

/** Pedidos de cliente de AS2 (año en curso), solo lectura. Para completarlos o vincularlos desde el portal. */
@Controller('as2/pedidos')
export class As2PedidosController {
  constructor(private readonly pedidos: As2PedidosService) {}

  @RequirePermission(Permission.AS2_PEDIDOS_VER)
  @Get()
  listar(@Query() q: As2PedidosQueryDto) {
    return this.pedidos.listar(q);
  }

  @RequirePermission(Permission.AS2_PEDIDOS_VER)
  @Get('resumen')
  resumen() {
    return this.pedidos.resumen();
  }

  @RequirePermission(Permission.AS2_PEDIDOS_VER)
  @Get(':id')
  detalle(@Param('id', ParseIntPipe) id: number) {
    return this.pedidos.detalle(id);
  }
}
