import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Permission } from '@dyn/authz';
import { AuthUser, CurrentUser, RequirePermission } from '@dyn/common';
import { OrdenesService } from '../services/ordenes.service';
import { ReportesService, type EstadoReporte } from '../services/reportes.service';

const P = Permission;
const ESTADOS_REPORTE = ['por_clasificar', 'descartado', 'clasificado'] as const;

export class ListarReportesDto {
  @IsOptional() @IsIn(ESTADOS_REPORTE) estado?: EstadoReporte;
  @IsOptional() @IsUUID() unidadId?: string;
  @IsOptional() @IsString() @MaxLength(60) q?: string;
}

export class ListarOrdenesDto {
  @IsOptional() @IsString() @MaxLength(30) estado?: string;
  @IsOptional() @IsUUID() unidadId?: string;
  /** Solo las órdenes con una sub-orden asignada a esta cuenta (para «Mis tareas»). */
  @IsOptional() @IsUUID() asignadaA?: string;
  @IsOptional() @IsString() @MaxLength(60) q?: string;
}

export class DescartarReporteDto {
  @IsString() @MaxLength(1000) motivo!: string;
}

export class AsignacionDto {
  @IsString() @MaxLength(30) tipo!: string;
  @IsOptional() @IsUUID() usuarioId?: string | null;
  @IsOptional() @IsBoolean() derivar?: boolean;
  @IsOptional() @IsString() @MaxLength(1000) notaDerivacion?: string | null;
}

export class ClasificarDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => AsignacionDto)
  asignaciones!: AsignacionDto[];
}

/** Reportes de unidad recibidos, clasificación y órdenes de mantenimiento. */
@Controller('operaciones/mantenimiento')
export class MantenimientoController {
  constructor(
    private readonly reportes: ReportesService,
    private readonly ordenes: OrdenesService,
  ) {}

  @RequirePermission(P.MANTENIMIENTO_VER, P.MANTENIMIENTO_OPERACIONES_VER)
  @Get('tipos-suborden')
  tipos() {
    return this.ordenes.tipos();
  }

  @RequirePermission(P.MANTENIMIENTO_VER, P.MANTENIMIENTO_OPERACIONES_VER)
  @Get('reportes')
  listarReportes(@Query() q: ListarReportesDto) {
    return this.reportes.listar(q);
  }

  @RequirePermission(P.MANTENIMIENTO_VER, P.MANTENIMIENTO_OPERACIONES_VER)
  @Get('reportes/:id')
  obtenerReporte(@Param('id', ParseUUIDPipe) id: string) {
    return this.reportes.obtener(id);
  }

  @RequirePermission(P.MANTENIMIENTO_GESTIONAR)
  @Post('reportes/:id/descartar')
  descartar(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DescartarReporteDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.reportes.descartar(id, dto.motivo, actor);
  }

  @RequirePermission(P.MANTENIMIENTO_GESTIONAR)
  @Post('reportes/:id/clasificar')
  clasificar(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ClasificarDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.ordenes.clasificar(id, dto.asignaciones, actor);
  }

  @RequirePermission(P.MANTENIMIENTO_VER, P.MANTENIMIENTO_OPERACIONES_VER)
  @Get('ordenes')
  listarOrdenes(@Query() q: ListarOrdenesDto) {
    return this.ordenes.listar(q);
  }

  @RequirePermission(P.MANTENIMIENTO_VER, P.MANTENIMIENTO_OPERACIONES_VER)
  @Get('ordenes/:id')
  obtenerOrden(@Param('id', ParseUUIDPipe) id: string) {
    return this.ordenes.obtener(id);
  }

  @RequirePermission(P.MANTENIMIENTO_GESTIONAR)
  @Put('ordenes/:id/clasificacion')
  reclasificar(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ClasificarDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.ordenes.reclasificar(id, dto.asignaciones, actor);
  }

  /** Todas las sub-órdenes de una unidad: la tarjeta «Mantenimientos» del ticket de Pumping. */
  @RequirePermission(P.MANTENIMIENTO_VER, P.MANTENIMIENTO_OPERACIONES_VER)
  @Get('unidades/:unidadId/subordenes')
  subordenesDeUnidad(@Param('unidadId', ParseUUIDPipe) unidadId: string) {
    return this.ordenes.subordenesDeUnidad(unidadId);
  }
}
