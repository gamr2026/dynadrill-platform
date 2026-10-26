import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { Permission } from '@dyn/authz';
import { AuthUser, CurrentUser, RequirePermission } from '@dyn/common';
import {
  ActualizarPedidoDto,
  AdjuntarDocumentoDto,
  AsignarAnalistaDto,
  CrearPedidoDto,
  DesdeAs2Dto,
  MotivoDto,
  PedidosQueryDto,
  TransicionDto,
  ValidarPlantillaDto,
  VincularAs2Dto,
  VinculosAs2QueryDto,
} from '../dto/pedidos.dto';
import { Contexto, PedidosService } from '../services/pedidos.service';

const P = Permission;
const token = (auth = '') => auth.replace(/^Bearer\s+/i, '');

/**
 * Pedidos del ciclo comercial. Los permisos de cada acción son granulares (`comercial.pedidos.*`); los pasos entre
 * estados se validan además contra el catálogo de transiciones (permiso y motivo por paso).
 */
@Controller('comercial/pedidos')
export class PedidosController {
  constructor(private readonly pedidos: PedidosService) {}

  private ctx(actor: AuthUser, auth?: string): Contexto {
    return { actor, token: token(auth) };
  }

  @RequirePermission(P.PEDIDOS_VER)
  @Get()
  listar(@Query() q: PedidosQueryDto) {
    return this.pedidos.listar(q);
  }

  /** Catálogo de estados del pedido (nombre, macro-estado y responsable). */
  @RequirePermission(P.PEDIDOS_VER)
  @Get('estados')
  estados() {
    return this.pedidos.estados();
  }

  /** Tipos de OT del catálogo. */
  @RequirePermission(P.PEDIDOS_VER)
  @Get('tipos-ot')
  tiposOt() {
    return this.pedidos.tiposOt();
  }

  /** Líneas de servicio con sus tipos y, bajo cada tipo, sus subtipos (catálogo en base de datos). */
  @RequirePermission(P.PEDIDOS_VER)
  @Get('catalogo-servicios')
  catalogoServicios() {
    return this.pedidos.catalogoServicios();
  }

  /** Qué pedidos de AS2 (por id) ya existen en el portal: `?ids=16651,16652`. */
  @RequirePermission(P.PEDIDOS_VER)
  @Get('vinculos-as2')
  vinculos(@Query() q: VinculosAs2QueryDto) {
    return this.pedidos.vinculosAs2(q.ids.split(',').map((s) => Number(s.trim())));
  }

  /** Valida las filas del Excel de AS2 contra la lista de precios del cliente (no guarda nada). */
  @RequirePermission(P.PEDIDOS_CREAR, P.PEDIDOS_EDITAR)
  @Post('validar-plantilla')
  validarPlantilla(@Body() dto: ValidarPlantillaDto) {
    return this.pedidos.validarPlantilla(dto);
  }

  /** Toma un pedido de AS2 y lo deja "por completar" en el portal. */
  @RequirePermission(P.PEDIDOS_CREAR)
  @Post('desde-as2')
  desdeAs2(
    @Body() dto: DesdeAs2Dto,
    @CurrentUser() actor: AuthUser,
    @Headers('authorization') auth?: string,
  ) {
    return this.pedidos.desdeAs2(dto.as2IdPedidoCliente, this.ctx(actor, auth));
  }

  @RequirePermission(P.PEDIDOS_VER)
  @Get(':id')
  detalle(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthUser,
    @Headers('authorization') auth?: string,
  ) {
    return this.pedidos.detalle(id, this.ctx(actor, auth));
  }

  @RequirePermission(P.PEDIDOS_CREAR)
  @Post()
  crear(
    @Body() dto: CrearPedidoDto,
    @CurrentUser() actor: AuthUser,
    @Headers('authorization') auth?: string,
  ) {
    return this.pedidos.crear(dto, this.ctx(actor, auth));
  }

  @RequirePermission(P.PEDIDOS_EDITAR)
  @Put(':id')
  editar(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ActualizarPedidoDto,
    @CurrentUser() actor: AuthUser,
    @Headers('authorization') auth?: string,
  ) {
    return this.pedidos.editar(id, dto, this.ctx(actor, auth));
  }

  /** Valida que esté completo, emite el código y abre el pedido. */
  @RequirePermission(P.PEDIDOS_CREAR, P.PEDIDOS_EDITAR)
  @Post(':id/abrir')
  abrir(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthUser,
    @Headers('authorization') auth?: string,
  ) {
    return this.pedidos.abrir(id, this.ctx(actor, auth));
  }

  @RequirePermission(P.PEDIDOS_ANULAR)
  @Post(':id/anular')
  anular(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MotivoDto,
    @CurrentUser() actor: AuthUser,
    @Headers('authorization') auth?: string,
  ) {
    return this.pedidos.anular(id, dto.motivo, this.ctx(actor, auth));
  }

  /** Facturación devuelve el pedido a Ventas para corrección. */
  @RequirePermission(P.PEDIDOS_RECHAZAR)
  @Post(':id/rechazar')
  rechazar(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MotivoDto,
    @CurrentUser() actor: AuthUser,
    @Headers('authorization') auth?: string,
  ) {
    return this.pedidos.rechazar(id, dto.motivo, this.ctx(actor, auth));
  }

  /**
   * Paso entre estados validado contra el catálogo de transiciones: el permiso que exige cada paso se verifica aquí
   * dentro. `forzar: true` (solo Superadmin) salta el flujo y exige motivo; queda registrado como "forzado".
   */
  @RequirePermission(P.PEDIDOS_VER)
  @Post(':id/transiciones')
  transicionar(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TransicionDto,
    @CurrentUser() actor: AuthUser,
    @Headers('authorization') auth?: string,
  ) {
    return this.pedidos.transicionar(
      id,
      dto.estado,
      dto.motivo,
      this.ctx(actor, auth),
      dto.forzar === true,
    );
  }

  @RequirePermission(P.PEDIDOS_ASIGNAR_ANALISTA)
  @Post(':id/asignar-analista')
  asignarAnalista(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AsignarAnalistaDto,
    @CurrentUser() actor: AuthUser,
    @Headers('authorization') auth?: string,
  ) {
    return this.pedidos.asignarAnalista(id, dto.analistaId, this.ctx(actor, auth));
  }

  /** Adjunta un archivo ya subido (`POST /api/archivos`, módulo `pedido_documento`) como documento del pedido. */
  @RequirePermission(P.PEDIDOS_EDITAR)
  @Post(':id/documentos')
  adjuntarDocumento(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdjuntarDocumentoDto,
    @CurrentUser() actor: AuthUser,
    @Headers('authorization') auth?: string,
  ) {
    return this.pedidos.adjuntarDocumento(id, dto.archivoId, dto.descripcion, this.ctx(actor, auth));
  }

  @RequirePermission(P.PEDIDOS_EDITAR)
  @Delete(':id/documentos/:documentoId')
  quitarDocumento(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('documentoId', ParseUUIDPipe) documentoId: string,
    @CurrentUser() actor: AuthUser,
    @Headers('authorization') auth?: string,
  ) {
    return this.pedidos.quitarDocumento(id, documentoId, this.ctx(actor, auth));
  }

  /** Vincula un pedido creado en el portal con el pedido de AS2 donde se registró. */
  @RequirePermission(P.PEDIDOS_EDITAR)
  @Post(':id/vincular-as2')
  vincularAs2(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VincularAs2Dto,
    @CurrentUser() actor: AuthUser,
    @Headers('authorization') auth?: string,
  ) {
    return this.pedidos.vincularAs2(id, dto.as2IdPedidoCliente, this.ctx(actor, auth));
  }

  /** Trae las líneas del pedido de AS2 como ítems (solo los códigos que están en la lista de precios del cliente). */
  @RequirePermission(P.PEDIDOS_EDITAR)
  @Post(':id/importar-lineas-as2')
  importarLineas(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthUser,
    @Headers('authorization') auth?: string,
  ) {
    return this.pedidos.importarLineasAs2(id, this.ctx(actor, auth));
  }
}
