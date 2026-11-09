import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength } from 'class-validator';
import { Permission } from '@dyn/authz';
import { AuthUser, CurrentUser, RequirePermission } from '@dyn/common';
import { AvanceService } from '../services/avance.service';
import { DuracionService } from '../services/duracion.service';
import { JornadasService } from '../services/jornadas.service';
import { TareasHoyService } from '../services/tareas-hoy.service';

const P = Permission;

export class SinOperacionDto {
  @IsUUID() motivoId!: string;
  @IsString() @MinLength(3) @MaxLength(500) detalle!: string;
}

export class CambiarDuracionDto {
  @IsIn(['acortar', 'ampliar']) accion!: 'acortar' | 'ampliar';
  /** Nueva fecha de fin del servicio (AAAA-MM-DD). */
  @Matches(/^\d{4}-\d{2}-\d{2}$/) fechaFin!: string;
  @IsString() @MinLength(3) @MaxLength(500) motivo!: string;
}

export class RevisarReporteLlegadaDto {
  @IsIn(['aprobada', 'rechazada']) decision!: 'aprobada' | 'rechazada';
  /** Obligatorio al rechazar. */
  @IsOptional() @IsString() @MaxLength(500) motivo?: string;
}

export class ReabrirJornadaDto {
  @IsString() @MinLength(3) @MaxLength(500) motivo!: string;
}

/** Jornadas (un día de operación) de un ticket de Pumping. La fecha va como AAAA-MM-DD. */
@Controller('operaciones/pumping')
export class JornadasController {
  constructor(
    private readonly jornadas: JornadasService,
    private readonly duracion: DuracionService,
    private readonly avance: AvanceService,
    private readonly tareas: TareasHoyService,
  ) {}

  /**
   * «Mis tareas de hoy» de Pumping: lo que la persona que consulta debe hacer hoy según su papel en cada servicio en ejecución (Operador,
   * Supervisor) y, si puede cambiar la duración, los servicios que van adelantados o atrasados (Jefe de Base).
   */
  @RequirePermission(P.PUMPING_OPERAR, P.PUMPING_VER)
  @Get('mis-tareas-hoy')
  misTareasHoy(@CurrentUser() actor: AuthUser) {
    return this.tareas.delUsuario(actor);
  }

  /** Las jornadas del ticket con su estado de hoy; en la Ejecución operativa se crean las que falten. */
  @RequirePermission(P.PUMPING_OPERAR, P.PUMPING_VER)
  @Get('tickets/:id/jornadas')
  listar(@Param('id', ParseUUIDPipe) id: string) {
    return this.jornadas.listar(id);
  }

  /** Revisión de reportes de llegada: por unidad y día trabajado, la inspección de llegada y el reporte de llegada con su estado. */
  @RequirePermission(P.PUMPING_OPERAR, P.PUMPING_VER)
  @Get('tickets/:id/revision-llegada')
  revisionLlegada(@Param('id', ParseUUIDPipe) id: string) {
    return this.jornadas.listarRevisionLlegada(id);
  }

  /** El Supervisor aprueba o rechaza (con motivo) el reporte de llegada de una unidad y un día. */
  @RequirePermission(P.PUMPING_REPORTE_LLEGADA_REVISAR)
  @Post('tickets/:id/reportes-unidad/:unidadId/:fecha/llegada/revision')
  revisarReporteLlegada(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('unidadId', ParseUUIDPipe) unidadId: string,
    @Param('fecha') fecha: string,
    @Body() dto: RevisarReporteLlegadaDto,
    @CurrentUser() actor: AuthUser,
  ) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) throw new BadRequestException('El día no es válido');
    return this.jornadas.revisarReporteLlegada(
      id,
      unidadId,
      fecha,
      dto.decision,
      dto.motivo,
      actor,
    );
  }

  /** Motivos para registrar un día sin operación. */
  @RequirePermission(P.PUMPING_OPERAR, P.PUMPING_VER)
  @Get('jornadas/motivos-sin-operacion')
  motivos() {
    return this.jornadas.motivosSinOperacion();
  }

  /** El Supervisor marca que el Company Man aceptó trabajar ese día; la jornada queda abierta. */
  @RequirePermission(P.PUMPING_JORNADA_ACEPTAR_COMPANY_MAN)
  @Post('tickets/:id/jornadas/:fecha/aceptacion-company-man')
  aceptar(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('fecha') fecha: string,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.jornadas.aceptarCompanyMan(id, fecha, actor);
  }

  /** Registra un día sin operación (motivo del catálogo y detalle). */
  @RequirePermission(P.PUMPING_OPERAR)
  @Post('tickets/:id/jornadas/:fecha/sin-operacion')
  sinOperacion(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('fecha') fecha: string,
    @Body() dto: SinOperacionDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.jornadas.sinOperacion(id, fecha, dto.motivoId, dto.detalle, actor);
  }

  /** El Supervisor cierra la jornada; no se cierra un día que todavía no llega. */
  @RequirePermission(P.PUMPING_JORNADA_CERRAR)
  @Post('tickets/:id/jornadas/:fecha/cerrar')
  cerrar(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('fecha') fecha: string,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.jornadas.cerrar(id, fecha, actor);
  }

  /** Avance del servicio: lo cotizado frente a lo usado por línea y el avance real frente al planificado. */
  @RequirePermission(P.PUMPING_OPERAR, P.PUMPING_VER)
  @Get('tickets/:id/avance')
  avanceDelServicio(@Param('id', ParseUUIDPipe) id: string) {
    return this.avance.obtener(id);
  }

  /** El Jefe de Base acorta o amplía la duración del servicio (nueva fecha de fin y motivo). */
  @RequirePermission(P.PUMPING_JORNADA_CAMBIAR_DURACION)
  @Post('tickets/:id/duracion')
  cambiarDuracion(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CambiarDuracionDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.duracion.cambiar(id, dto.accion, dto.fechaFin, dto.motivo, actor);
  }

  /** Reabre con motivo una jornada cerrada o sin operación. */
  @RequirePermission(P.PUMPING_JORNADA_REABRIR)
  @Post('tickets/:id/jornadas/:fecha/reabrir')
  reabrir(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('fecha') fecha: string,
    @Body() dto: ReabrirJornadaDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.jornadas.reabrir(id, fecha, dto.motivo, actor);
  }
}
