import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Permission } from '@dyn/authz';
import { AuthUser, CurrentUser, RequirePermission } from '@dyn/common';
import { EstadoObjetivoAmbiental } from '../generated/client';
import { ObjetivosAmbientalesConsultaService } from './objetivos-ambientales-consulta.service';
import { ObjetivosAmbientalesService } from './objetivos-ambientales.service';

const P = Permission;
const FECHA = /^\d{4}-\d{2}-\d{2}$/;

export class AccionPlanDto {
  @IsString() @MaxLength(2000) accionEspecifica!: string;
  @IsOptional() @IsUUID() responsableId?: string;
  @IsOptional() @IsString() @MaxLength(500) indicador?: string;
  @IsOptional() @IsString() @MaxLength(500) evidenciaEsperada?: string;
  @IsOptional() @IsUUID() frecuenciaId?: string;
}

export class CrearObjetivoDto {
  @IsString() @MaxLength(300) titulo!: string;
  @IsString() @MaxLength(2000) objetivo!: string;
  @IsString() @MaxLength(2000) meta!: string;
  @IsString() @MaxLength(1000) indicador!: string;
  @IsOptional() @IsString() @MaxLength(2000) beneficioEmpresarial?: string;
  @IsOptional() @Matches(FECHA) plazo?: string;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => AccionPlanDto)
  planAccion?: AccionPlanDto[];
}

export class EditarObjetivoDto {
  @IsOptional() @IsString() @MaxLength(300) titulo?: string;
  @IsOptional() @IsString() @MaxLength(2000) objetivo?: string;
  @IsOptional() @IsString() @MaxLength(2000) meta?: string;
  @IsOptional() @IsString() @MaxLength(1000) indicador?: string;
  @IsOptional() @IsString() @MaxLength(2000) beneficioEmpresarial?: string;
  @IsOptional() @Matches(FECHA) plazo?: string;
}

export class PlanAccionDto {
  @IsArray()
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => AccionPlanDto)
  acciones!: AccionPlanDto[];
}

export class SeguimientoDto {
  @IsOptional() @Matches(FECHA) fecha?: string;
  @IsInt() @Min(0) @Max(100) avancePorcentaje!: number;
  @IsString() @MaxLength(2000) observacion!: string;
}

export class CerrarObjetivoDto {
  @IsIn([EstadoObjetivoAmbiental.cumplido, EstadoObjetivoAmbiental.no_cumplido])
  estado!: EstadoObjetivoAmbiental;
  @IsString() @MaxLength(2000) resultado!: string;
  @IsOptional() @IsString() @MaxLength(2000) evidencia?: string;
}

export class ListarObjetivosDto {
  @IsOptional() @IsIn(Object.values(EstadoObjetivoAmbiental)) estado?: EstadoObjetivoAmbiental;
  @IsOptional() @IsString() @MaxLength(100) q?: string;
}

/**
 * Objetivos ambientales. Ruta pública `/api/v2/qhse/objetivos-ambientales`. Verlos: `qhse.objetivos_ambientales.ver`; registrarlos, darles
 * seguimiento y cerrarlos: `qhse.objetivos_ambientales.gestionar`. El Supervisor no entra.
 */
@Controller('qhse/objetivos-ambientales')
export class ObjetivosAmbientalesController {
  constructor(
    private readonly objetivos: ObjetivosAmbientalesService,
    private readonly consulta: ObjetivosAmbientalesConsultaService,
  ) {}

  @RequirePermission(P.OBJETIVOS_AMBIENTALES_VER)
  @Get('catalogos')
  catalogos() {
    return this.consulta.catalogos();
  }

  @RequirePermission(P.OBJETIVOS_AMBIENTALES_VER)
  @Get()
  listar(@Query() q: ListarObjetivosDto) {
    return this.consulta.listar(q);
  }

  @RequirePermission(P.OBJETIVOS_AMBIENTALES_VER)
  @Get(':id')
  detalle(@Param('id', ParseUUIDPipe) id: string) {
    return this.consulta.detalle(id);
  }

  @RequirePermission(P.OBJETIVOS_AMBIENTALES_GESTIONAR)
  @Post()
  crear(@Body() dto: CrearObjetivoDto, @CurrentUser() actor: AuthUser) {
    return this.objetivos.crear(dto, actor);
  }

  @RequirePermission(P.OBJETIVOS_AMBIENTALES_GESTIONAR)
  @Patch(':id')
  editar(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: EditarObjetivoDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.objetivos.editar(id, dto, actor);
  }

  @RequirePermission(P.OBJETIVOS_AMBIENTALES_GESTIONAR)
  @Put(':id/plan-accion')
  planAccion(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PlanAccionDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.objetivos.guardarPlanAccion(id, dto.acciones, actor);
  }

  @RequirePermission(P.OBJETIVOS_AMBIENTALES_GESTIONAR)
  @Post(':id/seguimientos')
  seguimiento(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SeguimientoDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.objetivos.registrarSeguimiento(id, dto, actor);
  }

  @RequirePermission(P.OBJETIVOS_AMBIENTALES_GESTIONAR)
  @Post(':id/cerrar')
  cerrar(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CerrarObjetivoDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.objetivos.cerrar(id, dto, actor);
  }
}
