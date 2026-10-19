import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { Permission } from '@dyn/authz';
import { AuthUser, CurrentUser, RequirePermission } from '@dyn/common';
import {
  IpercCatalogosService,
  TIPOS_CATALOGO_IPERC,
  type TipoCatalogoIperc,
} from './iperc-catalogos.service';
import { IpercConsultaService } from './iperc-consulta.service';
import {
  AdjuntarDto,
  AgregarCatalogoDto,
  CoberturaDto,
  ContenidoMatrizDto,
  CrearActividadDto,
  RechazarDto,
} from './iperc.dto';
import { IpercService } from './iperc.service';

const P = Permission;

export class ListarActividadesDto {
  @IsOptional() @IsString() @MaxLength(100) q?: string;
  @IsOptional() @IsUUID() procesoId?: string;
  @IsOptional() @IsUUID() zonaId?: string;
}

/**
 * Matriz IPERC maestra (DYN-SGI-RE-087, GTC 45). Ruta pública `/api/v2/qhse/iperc`. Verla y prepararla es del equipo HSE; aprobarla o
 * rechazarla, solo del Gerente HSE (`qhse.iperc.aprobar`). El Supervisor no entra: se entera por el PTW.
 */
@Controller('qhse/iperc')
export class IpercController {
  constructor(
    private readonly iperc: IpercService,
    private readonly consulta: IpercConsultaService,
    private readonly catalogos: IpercCatalogosService,
  ) {}

  @RequirePermission(P.IPERC_VER)
  @Get('catalogos')
  catalogosLista() {
    return this.catalogos.listar();
  }

  @RequirePermission(P.IPERC_GESTIONAR)
  @Post('catalogos/:tipo')
  agregarCatalogo(
    @Param('tipo') tipo: string,
    @Body() dto: AgregarCatalogoDto,
    @CurrentUser() actor: AuthUser,
  ) {
    if (!(TIPOS_CATALOGO_IPERC as readonly string[]).includes(tipo))
      throw new BadRequestException(`Catálogo desconocido: ${tipo}`);
    return this.catalogos.agregar(tipo as TipoCatalogoIperc, dto.nombre, actor.id);
  }

  @RequirePermission(P.IPERC_VER)
  @Get('actividades')
  actividades(@Query() q: ListarActividadesDto) {
    return this.consulta.actividades(q);
  }

  @RequirePermission(P.IPERC_GESTIONAR)
  @Post('actividades')
  crearActividad(@Body() dto: CrearActividadDto, @CurrentUser() actor: AuthUser) {
    return this.iperc.crearActividad(dto, actor);
  }

  @RequirePermission(P.IPERC_VER)
  @Get('actividades/:id/versiones')
  versiones(@Param('id', ParseUUIDPipe) id: string) {
    return this.consulta.versiones(id);
  }

  /** Revisión anual: crea una versión nueva copiada de la aprobada (la aprobada sigue valiendo hasta que se apruebe la nueva). */
  @RequirePermission(P.IPERC_GESTIONAR)
  @Post('actividades/:id/nueva-version')
  nuevaVersion(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthUser) {
    return this.iperc.nuevaVersion(id, actor);
  }

  @RequirePermission(P.IPERC_VER)
  @Get('tipos-servicio')
  tiposServicio() {
    return this.consulta.tiposDeServicioConocidos();
  }

  @RequirePermission(P.IPERC_VER)
  @Get('cobertura')
  cobertura() {
    return this.consulta.cobertura();
  }

  @RequirePermission(P.IPERC_GESTIONAR)
  @Put('cobertura/:tipoCodigo')
  fijarCobertura(
    @Param('tipoCodigo') tipoCodigo: string,
    @Body() dto: CoberturaDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.consulta.fijarCobertura(tipoCodigo, dto.actividadIds, actor);
  }

  @RequirePermission(P.IPERC_VER)
  @Get('matrices/:id')
  matriz(@Param('id', ParseUUIDPipe) id: string) {
    return this.consulta.matriz(id);
  }

  @RequirePermission(P.IPERC_GESTIONAR)
  @Put('matrices/:id/contenido')
  guardarContenido(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ContenidoMatrizDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.iperc.guardarContenido(id, dto, actor);
  }

  @RequirePermission(P.IPERC_GESTIONAR)
  @Post('matrices/:id/iniciar-evaluacion')
  iniciarEvaluacion(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthUser) {
    return this.iperc.iniciarEvaluacion(id, actor);
  }

  @RequirePermission(P.IPERC_GESTIONAR)
  @Post('matrices/:id/adjuntos')
  adjuntar(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdjuntarDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.iperc.adjuntar(id, dto.tipo, dto.archivoId, actor);
  }

  @RequirePermission(P.IPERC_GESTIONAR)
  @Post('matrices/:id/enviar-revision')
  enviarARevision(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthUser) {
    return this.iperc.enviarARevision(id, actor);
  }

  @RequirePermission(P.IPERC_APROBAR)
  @Post('matrices/:id/aprobar')
  aprobar(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthUser) {
    return this.iperc.aprobar(id, actor);
  }

  @RequirePermission(P.IPERC_APROBAR)
  @Post('matrices/:id/rechazar')
  rechazar(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RechazarDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.iperc.rechazar(id, dto.motivo, actor);
  }
}
