import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Permission } from '@dyn/authz';
import { AuthUser, CurrentUser, RequirePermission } from '@dyn/common';
import { EjecucionService } from '../services/ejecucion.service';
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

export class RepuestoDto {
  /** Repuesto del catálogo de Inventario (con su bodega)… */
  @IsOptional() @IsUUID() articuloId?: string | null;
  @IsOptional() @IsUUID() bodegaId?: string | null;
  /** …o, si no existe en el catálogo, su número de parte y descripción. */
  @IsOptional() @IsString() @MaxLength(80) numeroParte?: string | null;
  @IsOptional() @IsString() @MaxLength(300) descripcion?: string | null;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) @Max(99999999) cantidad!: number;
}

export class AvanceDto {
  @IsOptional() @IsString() @MaxLength(4000) diagnostico?: string | null;
  @IsOptional() @IsString() @MaxLength(4000) actividadesCorrectivas?: string | null;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(9999) horasTrabajo?: number | null;
  @IsOptional() @IsString() @MaxLength(4000) trabajosAdicionales?: string | null;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => RepuestoDto)
  repuestos?: RepuestoDto[];
}

export class RetornoDto {
  @IsIn(['disponible', 'con_restricciones']) estadoFinal!: 'disponible' | 'con_restricciones';
  @IsOptional() @IsString() @MaxLength(2000) observaciones?: string | null;
}

export class CorreccionDto {
  @IsString() @MaxLength(1000) nota!: string;
}

/** Reportes de unidad recibidos, clasificación y órdenes de mantenimiento. */
@Controller('operaciones/mantenimiento')
export class MantenimientoController {
  constructor(
    private readonly reportes: ReportesService,
    private readonly ordenes: OrdenesService,
    private readonly ejecucion: EjecucionService,
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

  // ── ejecución y cierre de la sub-orden (M2) ──────────────────────────────────────────────────────

  @RequirePermission(P.MANTENIMIENTO_VER, P.MANTENIMIENTO_OPERACIONES_VER, P.MANTENIMIENTO_TAREAS)
  @Get('subordenes/:id')
  obtenerSuborden(@Param('id', ParseUUIDPipe) id: string) {
    return this.ejecucion.obtener(id);
  }

  /** El operador guarda el avance: diagnóstico, actividades, horas y repuestos usados. */
  @RequirePermission(P.MANTENIMIENTO_TAREAS, P.MANTENIMIENTO_GESTIONAR)
  @Put('subordenes/:id/avance')
  guardarAvance(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AvanceDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.ejecucion.guardarAvance(id, dto, actor);
  }

  @RequirePermission(P.MANTENIMIENTO_TAREAS, P.MANTENIMIENTO_GESTIONAR)
  @Post('subordenes/:id/enviar-revision')
  enviarARevision(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthUser) {
    return this.ejecucion.enviarARevision(id, actor);
  }

  /** El Jefe aprueba el cierre: los repuestos del catálogo salen de bodega. */
  @RequirePermission(P.MANTENIMIENTO_GESTIONAR)
  @Post('subordenes/:id/aprobar-cierre')
  aprobarCierre(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthUser) {
    return this.ejecucion.aprobarCierre(id, actor);
  }

  @RequirePermission(P.MANTENIMIENTO_GESTIONAR)
  @Post('subordenes/:id/solicitar-correccion')
  solicitarCorreccion(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CorreccionDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.ejecucion.solicitarCorreccion(id, dto.nota, actor);
  }

  /** Fin correctivo: devuelve la unidad a Operaciones (solo con todas las sub-órdenes resueltas). */
  @RequirePermission(P.MANTENIMIENTO_GESTIONAR)
  @Post('ordenes/:id/retornar')
  retornar(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RetornoDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.ordenes.retornar(id, dto.estadoFinal, dto.observaciones ?? null, actor);
  }

  /** Todas las sub-órdenes de una unidad: la tarjeta «Mantenimientos» del ticket de Pumping. */
  @RequirePermission(P.MANTENIMIENTO_VER, P.MANTENIMIENTO_OPERACIONES_VER)
  @Get('unidades/:unidadId/subordenes')
  subordenesDeUnidad(@Param('unidadId', ParseUUIDPipe) unidadId: string) {
    return this.ordenes.subordenesDeUnidad(unidadId);
  }
}
