import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Permission } from '@dyn/authz';
import { AuthUser, CurrentUser, RequirePermission } from '@dyn/common';
import {
  ClasificacionAspecto,
  CondicionOperacionAspecto,
  EstadoAspecto,
  EstadoControlAspecto,
  TipoImpactoAspecto,
  TipoResponsabilidadAspecto,
} from '../generated/client';
import { AspectosAmbientalesConsultaService } from './aspectos-ambientales-consulta.service';
import { AspectosAmbientalesService } from './aspectos-ambientales.service';

const P = Permission;
const FECHA = /^\d{4}-\d{2}-\d{2}$/;

export class CrearAspectoDto {
  @IsOptional() @Matches(FECHA) fecha?: string;
  @IsUUID() etapaId!: string;
  @IsUUID() procesoId!: string;
  @IsString() @MaxLength(500) actividad!: string;
  @IsOptional() @IsString() @MaxLength(1000) produccionDelAspecto?: string;
  @IsOptional() @IsString() @MaxLength(1000) riesgoGestion?: string;
  @IsString() @MaxLength(1000) aspecto!: string;
  @IsString() @MaxLength(1000) impacto!: string;
  @IsOptional() @IsUUID() factorId?: string;
  @IsOptional()
  @IsIn(Object.values(CondicionOperacionAspecto))
  condicionOperacion?: CondicionOperacionAspecto;
  @IsOptional()
  @IsIn(Object.values(TipoResponsabilidadAspecto))
  tipoResponsabilidad?: TipoResponsabilidadAspecto;
  @IsOptional() @IsIn(Object.values(TipoImpactoAspecto)) tipoImpacto?: TipoImpactoAspecto;
  @IsOptional() @Matches(FECHA) fechaValoracion?: string;
  @IsInt() @Min(1) @Max(5) probabilidad!: number;
  @IsInt() @Min(1) @Max(5) consecuencia!: number;
  @IsIn(Object.values(ClasificacionAspecto)) clasificacion!: ClasificacionAspecto;
  @IsOptional() @IsString() @MaxLength(500) ncar?: string;
  @IsOptional() @IsString() @MaxLength(2000) planAccionExistente?: string;
  @IsOptional() @IsString() @MaxLength(2000) planTratamiento?: string;
  @IsOptional() @IsUUID() responsableId?: string;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) presupuesto?: number;
  @IsOptional() @Matches(FECHA) plazo?: string;
  @IsOptional() @IsIn(Object.values(EstadoControlAspecto)) estadoControl?: EstadoControlAspecto;
  @IsOptional() @IsString() @MaxLength(500) seguimientoIndicador?: string;
  @IsOptional() @IsUUID() seguimientoResponsableId?: string;
  @IsOptional() @IsUUID() seguimientoFrecuenciaId?: string;
}

/** Cambios parciales: cada campo es opcional y lo que no se envía queda como estaba. */
export class EditarAspectoDto {
  @IsOptional() @Matches(FECHA) fecha?: string;
  @IsOptional() @IsUUID() etapaId?: string;
  @IsOptional() @IsUUID() procesoId?: string;
  @IsOptional() @IsString() @MaxLength(500) actividad?: string;
  @IsOptional() @IsString() @MaxLength(1000) produccionDelAspecto?: string;
  @IsOptional() @IsString() @MaxLength(1000) riesgoGestion?: string;
  @IsOptional() @IsString() @MaxLength(1000) aspecto?: string;
  @IsOptional() @IsString() @MaxLength(1000) impacto?: string;
  @IsOptional() @IsUUID() factorId?: string;
  @IsOptional()
  @IsIn(Object.values(CondicionOperacionAspecto))
  condicionOperacion?: CondicionOperacionAspecto;
  @IsOptional()
  @IsIn(Object.values(TipoResponsabilidadAspecto))
  tipoResponsabilidad?: TipoResponsabilidadAspecto;
  @IsOptional() @IsIn(Object.values(TipoImpactoAspecto)) tipoImpacto?: TipoImpactoAspecto;
  @IsOptional() @Matches(FECHA) fechaValoracion?: string;
  @IsOptional() @IsInt() @Min(1) @Max(5) probabilidad?: number;
  @IsOptional() @IsInt() @Min(1) @Max(5) consecuencia?: number;
  @IsOptional() @IsIn(Object.values(ClasificacionAspecto)) clasificacion?: ClasificacionAspecto;
  @IsOptional() @IsString() @MaxLength(500) ncar?: string;
  @IsOptional() @IsString() @MaxLength(2000) planAccionExistente?: string;
  @IsOptional() @IsString() @MaxLength(2000) planTratamiento?: string;
  @IsOptional() @IsUUID() responsableId?: string;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) presupuesto?: number;
  @IsOptional() @Matches(FECHA) plazo?: string;
  @IsOptional() @IsIn(Object.values(EstadoControlAspecto)) estadoControl?: EstadoControlAspecto;
  @IsOptional() @IsString() @MaxLength(500) seguimientoIndicador?: string;
  @IsOptional() @IsUUID() seguimientoResponsableId?: string;
  @IsOptional() @IsUUID() seguimientoFrecuenciaId?: string;
}

export class SeguimientoAspectoDto {
  @IsOptional() @Matches(FECHA) fecha?: string;
  @IsBoolean() eficaz!: boolean;
  @IsString() @MaxLength(2000) observacion!: string;
}

export class BajaAspectoDto {
  @IsString() @MaxLength(1000) motivo!: string;
}

export class NuevoCatalogoDto {
  @IsString() @MaxLength(120) nombre!: string;
}

export class ListarAspectosDto {
  @IsOptional() @IsIn(Object.values(ClasificacionAspecto)) clasificacion?: ClasificacionAspecto;
  @IsOptional() @IsIn(Object.values(EstadoControlAspecto)) estadoControl?: EstadoControlAspecto;
  @IsOptional() @IsUUID() procesoId?: string;
  @IsOptional() @IsIn(Object.values(EstadoAspecto)) estado?: EstadoAspecto;
  @IsOptional() @IsString() @MaxLength(100) q?: string;
}

/**
 * Matriz de aspectos e impactos ambientales. Ruta pública `/api/v2/qhse/aspectos-ambientales`. Verla: `qhse.aspectos_ambientales.ver`; registrar,
 * editar, dar seguimiento, dar de baja y ampliar los catálogos: `qhse.aspectos_ambientales.gestionar`. El Supervisor no entra.
 */
@Controller('qhse/aspectos-ambientales')
export class AspectosAmbientalesController {
  constructor(
    private readonly aspectos: AspectosAmbientalesService,
    private readonly consulta: AspectosAmbientalesConsultaService,
  ) {}

  @RequirePermission(P.ASPECTOS_AMBIENTALES_VER)
  @Get('catalogos')
  catalogos() {
    return this.consulta.catalogos();
  }

  @RequirePermission(P.ASPECTOS_AMBIENTALES_GESTIONAR)
  @Post('catalogos/etapas-ciclo-vida')
  crearEtapa(@Body() dto: NuevoCatalogoDto, @CurrentUser() actor: AuthUser) {
    return this.aspectos.crearEtapa(dto.nombre, actor);
  }

  @RequirePermission(P.ASPECTOS_AMBIENTALES_GESTIONAR)
  @Post('catalogos/factores-ambientales')
  crearFactor(@Body() dto: NuevoCatalogoDto, @CurrentUser() actor: AuthUser) {
    return this.aspectos.crearFactor(dto.nombre, actor);
  }

  @RequirePermission(P.ASPECTOS_AMBIENTALES_VER)
  @Get()
  listar(@Query() q: ListarAspectosDto) {
    return this.consulta.listar(q);
  }

  @RequirePermission(P.ASPECTOS_AMBIENTALES_VER)
  @Get(':id')
  detalle(@Param('id', ParseUUIDPipe) id: string) {
    return this.consulta.detalle(id);
  }

  @RequirePermission(P.ASPECTOS_AMBIENTALES_GESTIONAR)
  @Post()
  crear(@Body() dto: CrearAspectoDto, @CurrentUser() actor: AuthUser) {
    return this.aspectos.crear(dto, actor);
  }

  @RequirePermission(P.ASPECTOS_AMBIENTALES_GESTIONAR)
  @Patch(':id')
  editar(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: EditarAspectoDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.aspectos.editar(id, dto, actor);
  }

  @RequirePermission(P.ASPECTOS_AMBIENTALES_GESTIONAR)
  @Post(':id/seguimientos')
  seguimiento(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SeguimientoAspectoDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.aspectos.registrarSeguimiento(id, dto, actor);
  }

  @RequirePermission(P.ASPECTOS_AMBIENTALES_GESTIONAR)
  @Post(':id/baja')
  baja(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: BajaAspectoDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.aspectos.darDeBaja(id, dto.motivo, actor);
  }
}
