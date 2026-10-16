import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { Permission } from '@dyn/authz';
import { AuthUser, CurrentUser, RequirePermission } from '@dyn/common';
import {
  EmitirOrdenTrabajoDto,
  RegistrarFacturaDto,
  RegistrarOrdenFirmadaDto,
} from '../dto/ordenes-trabajo.dto';
import { CierrePedidoService } from '../services/cierre-pedido.service';
import { ContextoOrden, OrdenesTrabajoService } from '../services/ordenes-trabajo.service';

const P = Permission;

/** Orden de trabajo (OT) del pedido y cierre: control de costos, listo para facturar y facturado. */
@Controller('comercial')
export class OrdenesTrabajoController {
  constructor(
    private readonly ordenes: OrdenesTrabajoService,
    private readonly cierre: CierrePedidoService,
  ) {}

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

  // ---- cierre ------------------------------------------------------------------------------------------------

  @RequirePermission(P.CIERRE_GESTIONAR)
  @Post('pedidos/:pedidoId/cierre/control-costos')
  controlCostos(
    @Param('pedidoId', ParseUUIDPipe) pedidoId: string,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.cierre.enviarControlCostos(pedidoId, actor);
  }

  @RequirePermission(P.CIERRE_GESTIONAR)
  @Post('pedidos/:pedidoId/cierre/listo-para-facturar')
  listo(@Param('pedidoId', ParseUUIDPipe) pedidoId: string, @CurrentUser() actor: AuthUser) {
    return this.cierre.listoParaFacturar(pedidoId, actor);
  }

  @RequirePermission(P.CIERRE_GESTIONAR)
  @Post('pedidos/:pedidoId/cierre/facturado')
  facturado(
    @Param('pedidoId', ParseUUIDPipe) pedidoId: string,
    @Body() dto: RegistrarFacturaDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.cierre.facturado(pedidoId, dto.numeroFactura, actor);
  }

  @RequirePermission(P.ORDENES_VER)
  @Get('pedidos/:pedidoId/cierre')
  estado(@Param('pedidoId', ParseUUIDPipe) pedidoId: string) {
    return this.cierre.estado(pedidoId);
  }
}
