import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { Permission } from '@dyn/authz';
import { AuthUser, CurrentUser, RequirePermission } from '@dyn/common';
import {
  ActualizarArticuloDto,
  ActualizarCategoriaDto,
  ActualizarSubcategoriaDto,
  CategoriaDto,
  ConsultarStockDto,
  CrearArticuloDto,
  ListarArticulosDto,
  ListarDespachosDto,
  ListarMotivosDto,
  ListarMovimientosDto,
  ParteDto,
  RegistrarMovimientoDto,
  SalidaDespachoDto,
  SubcategoriaDto,
  UnidadStockDto,
} from '../dto/inventario.dto';
import { ArticulosService } from '../services/articulos.service';
import { DespachosService } from '../services/despachos.service';
import { CatalogosService } from '../services/catalogos.service';
import { MovimientosService } from '../services/movimientos.service';
import { PartesService } from '../services/partes.service';

const P = Permission;

/**
 * Inventario: catálogo de artículos, kardex y existencias. Leer el catálogo lo pueden varios roles (`articulos.ver`);
 * administrarlo y registrar movimientos manuales es de Bodega (`articulos.gestionar`).
 */
@Controller('operaciones/inventario')
export class InventarioController {
  constructor(
    private readonly articulos: ArticulosService,
    private readonly movimientos: MovimientosService,
    private readonly partes: PartesService,
    private readonly catalogos: CatalogosService,
    private readonly despachos: DespachosService,
  ) {}

  // --- artículos ---
  @RequirePermission(P.ARTICULOS_VER)
  @Get('articulos')
  listar(@Query() q: ListarArticulosDto) {
    return this.articulos.listar(q);
  }

  /** Selector de repuestos de Mantenimiento (antes de `articulos/:id`, para que no se tome «repuestos» como un id). */
  @RequirePermission(P.ARTICULOS_VER, P.MANTENIMIENTO_TAREAS)
  @Get('articulos/repuestos')
  repuestos(@Query('q') q?: string) {
    return this.articulos.repuestosDisponibles(q);
  }

  @RequirePermission(P.ARTICULOS_VER)
  @Get('articulos/:id')
  detalle(@Param('id', ParseUUIDPipe) id: string) {
    return this.articulos.detalle(id);
  }

  @RequirePermission(P.ARTICULOS_GESTIONAR)
  @Post('articulos')
  crear(@Body() dto: CrearArticuloDto, @CurrentUser() actor: AuthUser) {
    return this.articulos.crear(dto, actor);
  }

  @RequirePermission(P.ARTICULOS_GESTIONAR)
  @Put('articulos/:id')
  actualizar(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ActualizarArticuloDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.articulos.actualizar(id, dto, actor);
  }

  /** Vuelve a publicar los artículos que se entregan a una persona para que QHSE los reciba (carga inicial o recuperación). */
  @RequirePermission(P.ARTICULOS_GESTIONAR)
  @Post('articulos/epi/republicar')
  republicarEpi(@CurrentUser() actor: AuthUser) {
    return this.articulos.republicarEpi(actor);
  }

  // --- kardex y existencias ---
  @RequirePermission(P.ARTICULOS_VER)
  @Get('articulos/:id/movimientos')
  kardex(@Param('id', ParseUUIDPipe) id: string, @Query() q: ListarMovimientosDto) {
    return this.movimientos.kardex(id, q);
  }

  @RequirePermission(P.ARTICULOS_VER)
  @Get('stock')
  async stock(@Query() q: ConsultarStockDto) {
    if (!q.articuloId) return [];
    const s = await this.movimientos.stock(q.articuloId);
    return q.bodegaId
      ? { ...s, porBodega: s.porBodega.filter((b) => b.bodegaId === q.bodegaId) }
      : s;
  }

  @RequirePermission(P.ARTICULOS_GESTIONAR)
  @Post('movimientos')
  registrarMovimiento(@Body() dto: RegistrarMovimientoDto, @CurrentUser() actor: AuthUser) {
    return this.movimientos.registrarManual(dto, actor);
  }

  // --- lo que tiene a su cargo un ticket de Pumping (calculado del kardex y del consumo) ---
  @RequirePermission(P.ARTICULOS_VER, P.INVENTARIO_CONSUMIR)
  @Get('tickets/:ticketId/articulos')
  async articulosDeTicket(@Param('ticketId', ParseUUIDPipe) ticketId: string) {
    const balance = await this.movimientos.balanceDeTicket(ticketId);
    return balance.map((b) => ({
      articuloId: b.articuloId,
      asignada: Number(b.asignada),
      usada: Number(b.usada),
      devuelta: Number(b.devuelta),
      pendiente: Number(b.pendiente),
    }));
  }

  // --- despachos a bodega (los solicita el ciclo comercial) ---
  @RequirePermission(P.DESPACHOS_VER)
  @Get('despachos')
  listarDespachos(@Query() q: ListarDespachosDto) {
    return this.despachos.listar(q);
  }

  @RequirePermission(P.DESPACHOS_VER)
  @Get('despachos/:id')
  detalleDespacho(@Param('id', ParseUUIDPipe) id: string) {
    return this.despachos.detalle(id);
  }

  @RequirePermission(P.DESPACHOS_GESTIONAR)
  @Post('despachos/:id/movimientos')
  salidaDeDespacho(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SalidaDespachoDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.despachos.registrarSalida(id, dto, actor);
  }

  // --- partes de una herramienta ---
  @RequirePermission(P.ARTICULOS_VER)
  @Get('articulos/:id/partes')
  partesDe(@Param('id', ParseUUIDPipe) id: string) {
    return this.partes.listar(id);
  }

  @RequirePermission(P.ARTICULOS_GESTIONAR)
  @Post('articulos/:id/partes')
  crearParte(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ParteDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.partes.crear(id, dto, actor.id);
  }

  @RequirePermission(P.ARTICULOS_GESTIONAR)
  @Put('partes/:parteId')
  actualizarParte(
    @Param('parteId', ParseUUIDPipe) parteId: string,
    @Body() dto: ParteDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.partes.actualizar(parteId, dto, actor.id);
  }

  @RequirePermission(P.ARTICULOS_GESTIONAR)
  @HttpCode(204)
  @Delete('partes/:parteId')
  async eliminarParte(@Param('parteId', ParseUUIDPipe) parteId: string): Promise<void> {
    await this.partes.eliminar(parteId);
  }

  // --- catálogos ---
  @RequirePermission(P.ARTICULOS_VER)
  @Get('categorias')
  categorias() {
    return this.catalogos.categorias();
  }

  @RequirePermission(P.ARTICULOS_GESTIONAR)
  @Post('categorias')
  crearCategoria(@Body() dto: CategoriaDto, @CurrentUser() actor: AuthUser) {
    return this.catalogos.crearCategoria(dto, actor.id);
  }

  @RequirePermission(P.ARTICULOS_GESTIONAR)
  @Put('categorias/:id')
  actualizarCategoria(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ActualizarCategoriaDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.catalogos.actualizarCategoria(id, dto, actor.id);
  }

  @RequirePermission(P.ARTICULOS_GESTIONAR)
  @Post('categorias/:id/subcategorias')
  crearSubcategoria(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SubcategoriaDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.catalogos.crearSubcategoria(id, dto, actor.id);
  }

  @RequirePermission(P.ARTICULOS_GESTIONAR)
  @Put('subcategorias/:id')
  actualizarSubcategoria(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ActualizarSubcategoriaDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.catalogos.actualizarSubcategoria(id, dto, actor.id);
  }

  @RequirePermission(P.ARTICULOS_VER)
  @Get('unidades')
  unidades() {
    return this.catalogos.unidades();
  }

  @RequirePermission(P.ARTICULOS_GESTIONAR)
  @Post('unidades')
  crearUnidad(@Body() dto: UnidadStockDto, @CurrentUser() actor: AuthUser) {
    return this.catalogos.crearUnidad(dto, actor.id);
  }

  @RequirePermission(P.ARTICULOS_VER)
  @Get('motivos')
  motivos(@Query() q: ListarMotivosDto) {
    return this.catalogos.motivos(q);
  }

  @RequirePermission(P.ARTICULOS_VER)
  @Get('bodegas')
  bodegas() {
    return this.catalogos.bodegas();
  }
}
