import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { IsBoolean, IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { Permission } from '@dyn/authz';
import { AuthUser, CurrentUser, RequirePermission } from '@dyn/common';
import { EstadoSwa } from '../generated/client';
import { SwaConsultaService } from './swa-consulta.service';
import { SwaService } from './swa.service';

const P = Permission;

export class ListarSwaDto {
  @IsOptional() @IsIn(Object.values(EstadoSwa)) estado?: EstadoSwa;
  @IsOptional() @IsUUID() ticketId?: string;
  @IsOptional() @IsString() @MaxLength(100) q?: string;
}

export class ActivarSwaDto {
  @IsUUID() tipoPeligroId!: string;
  @IsString() @MaxLength(2000) descripcion!: string;
  @IsOptional() @IsString() @MaxLength(300) ubicacion?: string;
  /** Servicio detenido (debe ser un ticket que QHSE conoce); sin ticket si la SWA no es de un servicio. */
  @IsOptional() @IsUUID() ticketId?: string;
}

export class NotificarSwaDto {
  @IsUUID() rolCadenaId!: string;
}

export class EvaluarSwaDto {
  @IsBoolean() riesgoReal!: boolean;
  @IsOptional() @IsString() @MaxLength(2000) nota?: string;
}

export class ConfirmarCriterioDto {
  @IsUUID() criterioId!: string;
}

export class ReanudarSwaDto {
  @IsOptional() @IsBoolean() heroeSeguridad?: boolean;
}

/**
 * Stop Work Authority. Ruta pública `/api/v2/qhse/swa`. Activarla es de cualquier usuario autenticado (permiso `qhse.eventos.reportar`,
 * que tienen todos los roles); verla y gestionarla es del equipo HSE. Una SWA sin cerrar bloquea el ticket (D10).
 */
@Controller('qhse/swa')
export class SwaController {
  constructor(
    private readonly swa: SwaService,
    private readonly consulta: SwaConsultaService,
  ) {}

  /** Catálogo para el formulario de activación (lo usa quien activa, aunque no vea la bandeja). */
  @RequirePermission(P.QHSE_REPORTAR)
  @Get('tipos-peligro')
  tipos() {
    return this.consulta.tiposDePeligro();
  }

  /** Servicios que se pueden detener (para elegir el ticket al activar). */
  @RequirePermission(P.QHSE_REPORTAR)
  @Get('tickets')
  tickets() {
    return this.consulta.ticketsParaActivar();
  }

  @RequirePermission(P.QHSE_REPORTAR)
  @Post()
  activar(@Body() dto: ActivarSwaDto, @CurrentUser() actor: AuthUser) {
    return this.swa.activar(dto, actor);
  }

  @RequirePermission(P.SWA_VER)
  @Get()
  listar(@Query() q: ListarSwaDto) {
    return this.consulta.listar(q);
  }

  @RequirePermission(P.SWA_VER)
  @Get(':id')
  detalle(@Param('id', ParseUUIDPipe) id: string) {
    return this.consulta.detalle(id);
  }

  @RequirePermission(P.SWA_GESTIONAR)
  @Post(':id/notificaciones')
  notificar(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: NotificarSwaDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.swa.notificar(id, dto.rolCadenaId, actor);
  }

  @RequirePermission(P.SWA_GESTIONAR)
  @Post(':id/evaluar')
  evaluar(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: EvaluarSwaDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.swa.evaluar(id, dto, actor);
  }

  @RequirePermission(P.SWA_GESTIONAR)
  @Post(':id/reinicio')
  confirmarCriterio(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ConfirmarCriterioDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.swa.confirmarCriterio(id, dto.criterioId, actor);
  }

  @RequirePermission(P.SWA_GESTIONAR)
  @Post(':id/reanudar')
  reanudar(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReanudarSwaDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.swa.reanudar(id, dto, actor);
  }
}
