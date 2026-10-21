import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { Permission } from '@dyn/authz';
import { AuthUser, CurrentUser, RequirePermission } from '@dyn/common';
import {
  AgregarFirmaDto,
  EnviarPrefacturaDto,
  FirmaCompanyManDto,
  FirmarPrefacturaDto,
  ListarPrefacturasQuery,
  ReemplazarFirmaDto,
  RechazarPrefacturaDto,
  RegistrarTicketDto,
} from '../dto/prefacturas.dto';
import { ContextoPrefactura, PrefacturasService } from '../services/prefacturas.service';

const P = Permission;

/** Prefactura del pedido: cálculo, envío, firmas y rechazo. Cada paso mueve el estado del pedido por el motor de estados. */
@Controller('comercial')
export class PrefacturasController {
  constructor(private readonly prefacturas: PrefacturasService) {}

  private ctx(actor: AuthUser, auth?: string): ContextoPrefactura {
    return { actor, token: (auth ?? '').replace(/^Bearer\s+/i, '') };
  }

  /** Índice de prefacturas (estado y texto opcionales). */
  @RequirePermission(P.PREFACTURAS_VER)
  @Get('prefacturas')
  indice(@Query() filtro: ListarPrefacturasQuery) {
    return this.prefacturas.listar(filtro);
  }

  @RequirePermission(P.PREFACTURAS_VER)
  @Get('pedidos/:pedidoId/prefacturas')
  listar(@Param('pedidoId', ParseUUIDPipe) pedidoId: string) {
    return this.prefacturas.listarDePedido(pedidoId);
  }

  /** Calcula la prefactura del pedido (exige la documentación operativa completa). */
  @RequirePermission(P.PREFACTURAS_GENERAR)
  @Post('pedidos/:pedidoId/prefacturas')
  generar(
    @Param('pedidoId', ParseUUIDPipe) pedidoId: string,
    @CurrentUser() actor: AuthUser,
    @Headers('authorization') auth?: string,
  ) {
    return this.prefacturas.generar(pedidoId, this.ctx(actor, auth));
  }

  /** «Ver prefactura» desde el ticket: la vigente o una preliminar calculada al vuelo (no guarda nada). */
  @RequirePermission(P.PREFACTURAS_VISTA_TICKET)
  @Get('pedidos/:pedidoId/prefactura-vista')
  vista(@Param('pedidoId', ParseUUIDPipe) pedidoId: string) {
    return this.prefacturas.vista(pedidoId);
  }

  /** El Supervisor sube el documento firmado por el Company Man: genera o recalcula la prefactura y la deja firmada. */
  @RequirePermission(P.PREFACTURAS_FIRMA_COMPANY_MAN)
  @Post('pedidos/:pedidoId/prefactura/firma-company-man')
  firmaCompanyMan(
    @Param('pedidoId', ParseUUIDPipe) pedidoId: string,
    @Body() dto: FirmaCompanyManDto,
    @CurrentUser() actor: AuthUser,
    @Headers('authorization') auth?: string,
  ) {
    return this.prefacturas.firmarDesdeTicket(pedidoId, dto, this.ctx(actor, auth));
  }

  @RequirePermission(P.PREFACTURAS_VER)
  @Get('prefacturas/:id')
  detalle(@Param('id', ParseUUIDPipe) id: string) {
    return this.prefacturas.detalle(id);
  }

  /** Líneas de la prefactura firmada para la plantilla de carga de AS2 (la descarga del archivo la arma la pantalla). */
  @RequirePermission(P.PREFACTURAS_VER)
  @Get('prefacturas/:id/exportacion-as2')
  exportacionAs2(@Param('id', ParseUUIDPipe) id: string) {
    return this.prefacturas.exportacionAs2(id);
  }

  @RequirePermission(P.PREFACTURAS_GENERAR)
  @Post('prefacturas/:id/recalcular')
  recalcular(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthUser,
    @Headers('authorization') auth?: string,
  ) {
    return this.prefacturas.recalcular(id, this.ctx(actor, auth));
  }

  /** Registra el número que AS2 asignó a la prefactura (PRC-). El ticket es la prefactura: este es su número. */
  @RequirePermission(P.PREFACTURAS_GENERAR)
  @Post('prefacturas/:id/ticket')
  ticket(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RegistrarTicketDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.prefacturas.registrarTicket(id, dto.numero, actor);
  }

  @RequirePermission(P.PREFACTURAS_ENVIAR)
  @Post('prefacturas/:id/enviar')
  enviar(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: EnviarPrefacturaDto,
    @CurrentUser() actor: AuthUser,
    @Headers('authorization') auth?: string,
  ) {
    return this.prefacturas.enviar(id, dto, this.ctx(actor, auth));
  }

  @RequirePermission(P.PREFACTURAS_FIRMAR)
  @Post('prefacturas/:id/firmas')
  agregarFirma(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AgregarFirmaDto,
    @CurrentUser() actor: AuthUser,
    @Headers('authorization') auth?: string,
  ) {
    return this.prefacturas.agregarFirma(id, dto, this.ctx(actor, auth));
  }

  /** Vuelve a leer la firma de un archivo registrado. Ayuda para revisar; no certifica la autenticidad. */
  /** Facturación carga el documento firmado nuevo en lugar del registrado; la anterior queda como historia y se vuelve a leer. */
  @RequirePermission(P.PREFACTURAS_FIRMAR)
  @Post('prefacturas/:id/firmas/:firmaId/reemplazar')
  reemplazarFirma(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('firmaId', ParseUUIDPipe) firmaId: string,
    @Body() dto: ReemplazarFirmaDto,
    @CurrentUser() actor: AuthUser,
    @Headers('authorization') auth?: string,
  ) {
    return this.prefacturas.reemplazarFirma(id, firmaId, dto, this.ctx(actor, auth));
  }

  @RequirePermission(P.PREFACTURAS_FIRMAR)
  @Post('prefacturas/:id/firmas/:firmaId/verificar')
  verificarFirma(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('firmaId', ParseUUIDPipe) firmaId: string,
    @CurrentUser() actor: AuthUser,
    @Headers('authorization') auth?: string,
  ) {
    return this.prefacturas.verificarFirma(id, firmaId, this.ctx(actor, auth));
  }

  @RequirePermission(P.PREFACTURAS_FIRMAR)
  @Post('prefacturas/:id/firmar')
  firmar(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: FirmarPrefacturaDto,
    @CurrentUser() actor: AuthUser,
    @Headers('authorization') auth?: string,
  ) {
    return this.prefacturas.firmar(id, dto, this.ctx(actor, auth));
  }

  @RequirePermission(P.PREFACTURAS_RECHAZAR)
  @Post('prefacturas/:id/rechazar')
  rechazar(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RechazarPrefacturaDto,
    @CurrentUser() actor: AuthUser,
    @Headers('authorization') auth?: string,
  ) {
    return this.prefacturas.rechazar(id, dto, this.ctx(actor, auth));
  }
}
