import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Permission } from '@dyn/authz';
import { AuthUser, CurrentUser, RequirePermission } from '@dyn/common';
import { ReportesDiariosService } from '../services/reportes-diarios.service';

const P = Permission;
const HORA = /^([01]\d|2[0-3]):[0-5]\d$/;

export class TablaDto {
  @IsOptional() @IsString() @MaxLength(200) titulo?: string;
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  columnas!: string[];
  @IsArray()
  @ArrayMaxSize(500)
  @IsArray({ each: true })
  filas!: string[][];
}

export class ActividadDiariaDto {
  @Matches(HORA, { message: 'La hora de inicio debe ser HH:mm' }) horaInicio!: string;
  @Matches(HORA, { message: 'La hora de fin debe ser HH:mm' }) horaFin!: string;
  @IsString() @MaxLength(4000) detalle!: string;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => TablaDto)
  tablas?: TablaDto[];
}

export class GuardarReporteDiarioDto {
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => ActividadDiariaDto)
  actividades!: ActividadDiariaDto[];
  @IsOptional() @IsString() @MaxLength(200) representanteCliente?: string;
  @IsOptional() @IsString() @MaxLength(200) cargoRepresentante?: string;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(24) tiempoProductivo?: number;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(24) tiempoNoProductivo?: number;
  @IsOptional() @IsString() @MaxLength(4000) observaciones?: string;
}

/** Reporte Diario de Actividades (DYN-SGI-RE-047, el «Reporte Job») de un ticket. */
@Controller('operaciones/pumping/tickets/:id/reportes-diarios')
export class ReportesDiariosController {
  constructor(private readonly reportes: ReportesDiariosService) {}

  /** Los días del ticket con su estado (borrador, completado o corregido por Facturación) y sus horas. */
  @RequirePermission(P.PUMPING_OPERAR)
  @Get()
  listar(@Param('id', ParseUUIDPipe) id: string) {
    return this.reportes.listar(id);
  }

  @RequirePermission(P.PUMPING_OPERAR)
  @Get(':fecha')
  obtener(@Param('id', ParseUUIDPipe) id: string, @Param('fecha') fecha: string) {
    return this.reportes.obtener(id, fecha);
  }

  /** Guarda el día como borrador (reemplaza sus actividades y tablas; si estaba completado, lo reabre). */
  @RequirePermission(P.PUMPING_OPERAR)
  @Put(':fecha')
  guardar(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('fecha') fecha: string,
    @Body() dto: GuardarReporteDiarioDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.reportes.guardar(id, fecha, dto, actor);
  }

  /** Completa el día y lo envía a Comercial como Reporte Job. */
  @RequirePermission(P.PUMPING_OPERAR)
  @Post(':fecha/completar')
  completar(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('fecha') fecha: string,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.reportes.completar(id, fecha, actor);
  }
}
