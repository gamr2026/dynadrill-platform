import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Permission } from '@dyn/authz';
import { AuthUser, CurrentUser, RequirePermission } from '@dyn/common';
import { ResultadoInspeccion } from '../generated/client';
import { InspeccionesConsultaService } from './inspecciones-consulta.service';
import { InspeccionesService } from './inspecciones.service';

const P = Permission;
const FECHA = /^\d{4}-\d{2}-\d{2}$/;

export class ResultadoCriterioDto {
  @IsUUID() criterioId!: string;
  @IsBoolean() cumple!: boolean;
}

export class RegistrarInspeccionDto {
  @IsUUID() tipoId!: string;
  /** Número o código del equipo (la eslinga, el detector o la unidad). */
  @IsString() @MaxLength(100) equipoCodigo!: string;
  /** Solo el vehículo-grúa: la unidad de Flota (id) y su código. */
  @IsOptional() @IsUUID() unidadId?: string;
  @IsOptional() @IsString() @MaxLength(100) unidadCodigo?: string;
  @IsOptional() @Matches(FECHA) fecha?: string;
  /** Solo el detector de gas: si se hizo el bump test. */
  @IsOptional() @IsBoolean() bumpTestRealizado?: boolean;
  @IsOptional() @IsString() @MaxLength(2000) observaciones?: string;
  @IsOptional() @IsUUID() ticketId?: string;
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => ResultadoCriterioDto)
  resultados!: ResultadoCriterioDto[];
}

export class ListarInspeccionesDto {
  @IsOptional() @IsUUID() tipoId?: string;
  @IsOptional() @IsIn(Object.values(ResultadoInspeccion)) resultado?: ResultadoInspeccion;
  @IsOptional() @Matches(FECHA) desde?: string;
  @IsOptional() @Matches(FECHA) hasta?: string;
  @IsOptional() @IsString() @MaxLength(100) q?: string;
}

/**
 * Inspecciones de campo. Ruta pública `/api/v2/qhse/inspecciones`. Registrar (y los tipos con sus criterios) es de cualquier usuario
 * autenticado; la bandeja, el estado de los equipos y el detalle son del equipo HSE.
 */
@Controller('qhse/inspecciones')
export class InspeccionesController {
  constructor(
    private readonly inspecciones: InspeccionesService,
    private readonly consulta: InspeccionesConsultaService,
  ) {}

  @RequirePermission(P.QHSE_REPORTAR)
  @Get('tipos')
  tipos() {
    return this.consulta.tipos();
  }

  @RequirePermission(P.QHSE_REPORTAR)
  @Post()
  registrar(@Body() dto: RegistrarInspeccionDto, @CurrentUser() actor: AuthUser) {
    return this.inspecciones.registrar(dto, actor);
  }

  /** Cuarentena y próxima inspección debida de cada equipo. */
  @RequirePermission(P.QHSE_INSPECCIONES_VER)
  @Get('equipos')
  equipos() {
    return this.consulta.equipos();
  }

  @RequirePermission(P.QHSE_INSPECCIONES_VER)
  @Get()
  listar(@Query() q: ListarInspeccionesDto) {
    return this.consulta.listar(q);
  }

  @RequirePermission(P.QHSE_INSPECCIONES_VER)
  @Get(':id')
  detalle(@Param('id', ParseUUIDPipe) id: string) {
    return this.consulta.detalle(id);
  }
}
