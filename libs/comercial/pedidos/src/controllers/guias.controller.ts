import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { Permission } from '@dyn/authz';
import { AuthUser, CurrentUser, RequirePermission } from '@dyn/common';
import {
  AnularGuiaDto,
  CrearLugarDespachoDto,
  EmitirGuiaDto,
  ReasignarNumeroGuiaDto,
  RealizarDespachoDto,
  RegistrarGuiaFirmadaDto,
} from '../dto/guias.dto';
import { ContextoGuia, GuiasService } from '../services/guias.service';

const P = Permission;

/** Guía de remisión del pedido y despacho a Bodega. */
@Controller('comercial')
export class GuiasController {
  constructor(private readonly guias: GuiasService) {}

  private ctx(actor: AuthUser, auth?: string): ContextoGuia {
    return { actor, token: (auth ?? '').replace(/^Bearer\s+/i, '') };
  }

  @RequirePermission(P.GUIAS_VER)
  @Get('pedidos/:pedidoId/guias')
  listar(@Param('pedidoId', ParseUUIDPipe) pedidoId: string) {
    return this.guias.listarDePedido(pedidoId);
  }

  /** Lo que se propone para la guía (herramientas reportadas y materiales del pedido); se edita antes de emitir. */
  @RequirePermission(P.GUIAS_VER)
  @Get('pedidos/:pedidoId/guias/items-sugeridos')
  sugeridos(@Param('pedidoId', ParseUUIDPipe) pedidoId: string) {
    return this.guias.sugerirItems(pedidoId);
  }

  @RequirePermission(P.GUIAS_EMITIR)
  @Post('pedidos/:pedidoId/guias')
  emitir(
    @Param('pedidoId', ParseUUIDPipe) pedidoId: string,
    @Body() dto: EmitirGuiaDto,
    @CurrentUser() actor: AuthUser,
    @Headers('authorization') auth?: string,
  ) {
    return this.guias.emitir(pedidoId, dto, this.ctx(actor, auth));
  }

  @RequirePermission(P.GUIAS_VER)
  @Get('guias/lugares-despacho')
  lugares() {
    return this.guias.lugares();
  }

  @RequirePermission(P.GUIAS_EMITIR)
  @Post('guias/lugares-despacho')
  crearLugar(@Body() dto: CrearLugarDespachoDto) {
    return this.guias.crearLugar(dto.nombre);
  }

  @RequirePermission(P.GUIAS_VER)
  @Get('guias/:id')
  detalle(@Param('id', ParseUUIDPipe) id: string) {
    return this.guias.detalle(id);
  }

  @RequirePermission(P.GUIAS_EMITIR)
  @Post('guias/:id/reasignar-numero')
  reasignar(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReasignarNumeroGuiaDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.guias.reasignarNumero(id, dto.numero, dto.motivo, actor);
  }

  @RequirePermission(P.GUIAS_EMITIR)
  @Post('guias/:id/anular')
  anular(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AnularGuiaDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.guias.anular(id, dto.motivo, actor);
  }

  @RequirePermission(P.GUIAS_FIRMAR)
  @Post('guias/:id/firmada')
  firmada(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RegistrarGuiaFirmadaDto,
    @CurrentUser() actor: AuthUser,
    @Headers('authorization') auth?: string,
  ) {
    return this.guias.registrarFirmada(id, dto.archivoId, this.ctx(actor, auth));
  }

  /** Vuelve a validar las firmas digitales del PDF firmado (ayuda para revisar). */
  @RequirePermission(P.GUIAS_FIRMAR)
  @Post('guias/:id/verificar-firma-electronica')
  verificarFirmaElectronica(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthUser,
    @Headers('authorization') auth?: string,
  ) {
    return this.guias.verificarFirmaElectronica(id, this.ctx(actor, auth));
  }

  // ---- despacho a Bodega ------------------------------------------------------------------------------------

  @RequirePermission(P.GUIAS_VER)
  @Get('pedidos/:pedidoId/despacho')
  despacho(@Param('pedidoId', ParseUUIDPipe) pedidoId: string) {
    return this.guias.estadoDespacho(pedidoId);
  }

  @RequirePermission(P.DESPACHO_SOLICITAR)
  @Post('pedidos/:pedidoId/despacho/solicitar')
  solicitar(@Param('pedidoId', ParseUUIDPipe) pedidoId: string, @CurrentUser() actor: AuthUser) {
    return this.guias.solicitarDespacho(pedidoId, actor);
  }

  @RequirePermission(P.DESPACHOS_GESTIONAR)
  @Post('pedidos/:pedidoId/despacho/realizar')
  realizar(
    @Param('pedidoId', ParseUUIDPipe) pedidoId: string,
    @Body() dto: RealizarDespachoDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.guias.realizarDespacho(pedidoId, dto, actor);
  }
}
