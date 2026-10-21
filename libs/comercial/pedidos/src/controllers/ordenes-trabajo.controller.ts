import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { Permission } from '@dyn/authz';
import { AuthUser, CurrentUser, RequirePermission } from '@dyn/common';
import { EmitirOrdenTrabajoDto, RegistrarOrdenFirmadaDto } from '../dto/ordenes-trabajo.dto';
import { ContextoOrden, OrdenesTrabajoService } from '../services/ordenes-trabajo.service';

const P = Permission;

/** Orden de trabajo (OT) del pedido. El cierre (control de costos y factura) queda fuera del aplicativo. */
@Controller('comercial')
export class OrdenesTrabajoController {
  constructor(private readonly ordenes: OrdenesTrabajoService) {}

  private ctx(actor: AuthUser, auth?: string): ContextoOrden {
    return { actor, token: (auth ?? '').replace(/^Bearer\s+/i, '') };
  }

  @RequirePermission(P.ORDENES_VER)
  @Get('pedidos/:pedidoId/orden-trabajo')
  delPedido(@Param('pedidoId', ParseUUIDPipe) pedidoId: string) {
    return this.ordenes.delPedido(pedidoId);
  }

  @RequirePermission(P.ORDENES_VER)
  @Get('ordenes-trabajo/ciudades')
  ciudades() {
    return this.ordenes.ciudades();
  }

  @RequirePermission(P.ORDENES_EMITIR)
  @Post('pedidos/:pedidoId/orden-trabajo')
  emitir(
    @Param('pedidoId', ParseUUIDPipe) pedidoId: string,
    @Body() dto: EmitirOrdenTrabajoDto,
    @CurrentUser() actor: AuthUser,
    @Headers('authorization') auth?: string,
  ) {
    return this.ordenes.emitir(pedidoId, dto, this.ctx(actor, auth));
  }

  @RequirePermission(P.ORDENES_FIRMAR)
  @Post('ordenes-trabajo/:id/firmada')
  firmada(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RegistrarOrdenFirmadaDto,
    @CurrentUser() actor: AuthUser,
    @Headers('authorization') auth?: string,
  ) {
    return this.ordenes.marcarFirmada(id, dto.archivoId, this.ctx(actor, auth));
  }
}
