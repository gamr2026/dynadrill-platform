import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, MaxLength, Min } from 'class-validator';
import { Permission } from '@dyn/authz';
import { AuthUser, CurrentUser, RequirePermission } from '@dyn/common';
import { EmergenciasPlanService } from './emergencias-plan.service';
import { EmergenciasConsultaService } from './emergencias-consulta.service';
import { EmergenciasService } from './emergencias.service';

const P = Permission;

export class ListarEmergenciasDto {
  @IsOptional() @IsIn(['activa', 'controlada', 'cerrada']) estado?:
    'activa' | 'controlada' | 'cerrada';
  @IsOptional() @IsUUID() ticketId?: string;
  @IsOptional() @IsString() @MaxLength(100) q?: string;
}

export class ActivarEmergenciaDto {
  @IsUUID() tipoId!: string;
  @IsString() @MaxLength(2000) descripcion!: string;
  @IsOptional() @IsString() @MaxLength(300) ubicacion?: string;
  @IsOptional() @IsUUID() ticketId?: string;
  @IsOptional() @IsUUID() origenSwaId?: string;
  @IsOptional() @IsUUID() origenDerrameId?: string;
}

export class DeclararNivelDto {
  /** 1 menor, 2 moderada, 3 mayor. */
  @IsIn([1, 2, 3]) nivel!: 1 | 2 | 3;
}

export class RegistrarConteoDto {
  @IsInt() @Min(0) totalEnLocacion!: number;
  @IsInt() @Min(0) evacuados!: number;
}

export class NotificarPasoDto {
  @IsUUID() pasoId!: string;
}

export class AgregarLineaDto {
  @IsString() @MaxLength(1000) texto!: string;
}

/**
 * Emergencias / MEDEVAC. Ruta pública `/api/v2/qhse/emergencias`. Activar es de cualquier usuario autenticado (`qhse.eventos.reportar`);
 * verlas y gestionarlas es del equipo HSE.
 */
@Controller('qhse/emergencias')
export class EmergenciasController {
  constructor(
    private readonly emergencias: EmergenciasService,
    private readonly plan: EmergenciasPlanService,
    private readonly consulta: EmergenciasConsultaService,
  ) {}

  /** Catálogos del formulario de activación (lo usa quien reporta, aunque no vea la bandeja). */
  @RequirePermission(P.QHSE_REPORTAR)
  @Get('catalogos')
  catalogos() {
    return this.consulta.catalogos();
  }

  @RequirePermission(P.QHSE_REPORTAR)
  @Post()
  activar(@Body() dto: ActivarEmergenciaDto, @CurrentUser() actor: AuthUser) {
    return this.emergencias.activar(dto, actor);
  }

  @RequirePermission(P.EMERGENCIAS_VER)
  @Get()
  listar(@Query() q: ListarEmergenciasDto) {
    return this.consulta.listar(q);
  }

  @RequirePermission(P.EMERGENCIAS_VER)
  @Get(':id')
  detalle(@Param('id', ParseUUIDPipe) id: string) {
    return this.consulta.detalle(id);
  }

  /** Agrega una línea al cronómetro del evento. */
  @RequirePermission(P.EMERGENCIAS_GESTIONAR)
  @Post(':id/cronometro')
  agregarLinea(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AgregarLineaDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.emergencias.agregarLinea(id, dto.texto, actor);
  }

  /** Base HSE declara el nivel de la emergencia (1 a 3); se puede cambiar mientras no esté cerrada. */
  @RequirePermission(P.EMERGENCIAS_GESTIONAR)
  @Post(':id/nivel')
  declararNivel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DeclararNivelDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.plan.declararNivel(id, dto.nivel, actor);
  }

  /** Conteo de personal: en la locación y evacuados (los faltantes se calculan). */
  @RequirePermission(P.EMERGENCIAS_GESTIONAR)
  @Post(':id/conteo')
  registrarConteo(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RegistrarConteoDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.plan.registrarConteo(id, dto, actor);
  }

  /** Registra un paso de la cascada de notificación; informa si se cumplió su plazo. */
  @RequirePermission(P.EMERGENCIAS_GESTIONAR)
  @Post(':id/notificaciones')
  notificarPaso(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: NotificarPasoDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.plan.notificarPaso(id, dto.pasoId, actor);
  }
}
