import { Type } from 'class-transformer';
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
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { Permission } from '@dyn/authz';
import { AuthUser, CurrentUser, RequirePermission } from '@dyn/common';
import { EmergenciasCierreService } from './emergencias-cierre.service';
import { EmergenciasHeridosService } from './emergencias-heridos.service';
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

const TRIAGES = ['rojo', 'amarillo', 'verde', 'negro'] as const;
const MEDIOS = ['ambulancia', 'lancha', 'helicoptero'] as const;
const CONSCIENCIAS = ['alerta', 'voz', 'dolor', 'inconsciente'] as const;

export class RegistrarHeridoDto {
  @IsString() @MaxLength(200) nombreCompleto!: string;
  @IsOptional() @IsString() @MaxLength(20) cedula?: string;
  @IsIn(TRIAGES) triage!: (typeof TRIAGES)[number];
  @IsString() @MaxLength(500) mecanismoLesion!: string;
  @IsOptional() @IsString() @MaxLength(1000) lesiones?: string;
  @IsOptional() @IsString() @MaxLength(1000) tratamientoCampo?: string;
}

export class ActualizarHeridoDto {
  @IsOptional() @IsIn(TRIAGES) triage?: (typeof TRIAGES)[number];
  @IsOptional() @IsString() @MaxLength(1000) lesiones?: string;
  @IsOptional() @IsString() @MaxLength(1000) tratamientoCampo?: string;
}

export class SignosVitalesDto {
  @IsOptional() @IsInt() @Min(0) @Max(300) pulso?: number;
  @IsOptional() @IsInt() @Min(0) @Max(300) presionSistolica?: number;
  @IsOptional() @IsInt() @Min(0) @Max(300) presionDiastolica?: number;
  @IsOptional() @IsInt() @Min(0) @Max(100) respiracion?: number;
  @IsOptional() @IsIn(CONSCIENCIAS) consciencia?: (typeof CONSCIENCIAS)[number];
}

export class DatosMedevacDto {
  @IsOptional() @IsIn(MEDIOS) medioTransporte?: (typeof MEDIOS)[number];
  @IsOptional() @IsUUID() hospitalId?: string;
  @IsOptional() @IsInt() @Min(1) @Max(10080) etaMinutos?: number;
}

export class AgregarHospitalDto {
  @IsString() @MaxLength(200) nombre!: string;
  @IsString() @MaxLength(100) ciudad!: string;
  @IsOptional() @IsString() @MaxLength(50) telefono?: string;
}

export class ResumenEmergenciasDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(2000) @Max(2200) anio?: number;
}

export class ReporteFlashDto {
  @IsString() @MaxLength(3000) resumenEjecutivo!: string;
  @IsString() @MaxLength(3000) personalAfectado!: string;
  @IsString() @MaxLength(3000) accionesTomadas!: string;
  @IsString() @MaxLength(3000) estadoActual!: string;
  @IsString() @MaxLength(3000) proximosPasos!: string;
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
    private readonly heridos: EmergenciasHeridosService,
    private readonly cierre: EmergenciasCierreService,
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

  /** Tablero del año: por estado y nivel, heridos por triage, MEDEVAC y Reporte Flash. Va antes de `:id`. */
  @RequirePermission(P.EMERGENCIAS_VER)
  @Get('resumen')
  resumen(@Query() q: ResumenEmergenciasDto) {
    return this.consulta.tablero(q.anio);
  }

  /** Hospitales a los que se evacúa. Va antes de `:id`. */
  @RequirePermission(P.EMERGENCIAS_VER)
  @Get('hospitales')
  hospitales() {
    return this.heridos.hospitales();
  }

  /** Agrega un hospital al catálogo (el equipo HSE lo amplía). */
  @RequirePermission(P.EMERGENCIAS_GESTIONAR)
  @Post('hospitales')
  agregarHospital(@Body() dto: AgregarHospitalDto, @CurrentUser() actor: AuthUser) {
    return this.heridos.agregarHospital(dto, actor);
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

  // ------------------------------------------------------------------------------------- heridos, triage y MEDEVAC

  /** Registra un herido con su triage por color. */
  @RequirePermission(P.EMERGENCIAS_GESTIONAR)
  @Post(':id/heridos')
  registrarHerido(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RegistrarHeridoDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.heridos.registrar(id, dto, actor);
  }

  /** Cambia el triage o completa las lesiones y el tratamiento en campo. */
  @RequirePermission(P.EMERGENCIAS_GESTIONAR)
  @Patch(':id/heridos/:heridoId')
  actualizarHerido(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('heridoId', ParseUUIDPipe) heridoId: string,
    @Body() dto: ActualizarHeridoDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.heridos.actualizar(id, heridoId, dto, actor);
  }

  /** Toma de signos vitales (cada una es un registro nuevo). */
  @RequirePermission(P.EMERGENCIAS_GESTIONAR)
  @Post(':id/heridos/:heridoId/signos-vitales')
  registrarSignos(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('heridoId', ParseUUIDPipe) heridoId: string,
    @Body() dto: SignosVitalesDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.heridos.registrarSignos(id, heridoId, dto, actor);
  }

  /** Activa el MEDEVAC del herido. */
  @RequirePermission(P.EMERGENCIAS_GESTIONAR)
  @Post(':id/heridos/:heridoId/medevac')
  activarMedevac(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('heridoId', ParseUUIDPipe) heridoId: string,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.heridos.activarMedevac(id, heridoId, actor);
  }

  /** Medio de transporte, hospital de destino y ETA del MEDEVAC. */
  @RequirePermission(P.EMERGENCIAS_GESTIONAR)
  @Put(':id/heridos/:heridoId/medevac')
  datosMedevac(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('heridoId', ParseUUIDPipe) heridoId: string,
    @Body() dto: DatosMedevacDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.heridos.datosMedevac(id, heridoId, dto, actor);
  }

  /** Registra que se notificó al hospital (exige el medio de transporte y el hospital de destino). */
  @RequirePermission(P.EMERGENCIAS_GESTIONAR)
  @Post(':id/heridos/:heridoId/hospital-notificado')
  notificarHospital(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('heridoId', ParseUUIDPipe) heridoId: string,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.heridos.notificarHospital(id, heridoId, actor);
  }

  /** Registra la transferencia del herido al hospital (exige haber notificado al hospital). */
  @RequirePermission(P.EMERGENCIAS_GESTIONAR)
  @Post(':id/heridos/:heridoId/transferir')
  transferir(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('heridoId', ParseUUIDPipe) heridoId: string,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.heridos.transferir(id, heridoId, actor);
  }

  // ------------------------------------------------------------------------- Reporte Flash, controlada y cierre

  /** Emite el Reporte Flash (una sola vez, completo); su plazo de 2 horas se informa y no bloquea. */
  @RequirePermission(P.EMERGENCIAS_GESTIONAR)
  @Post(':id/reporte-flash')
  reporteFlash(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReporteFlashDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.cierre.emitirReporteFlash(id, dto, actor);
  }

  /** Marca la emergencia como controlada. */
  @RequirePermission(P.EMERGENCIAS_GESTIONAR)
  @Post(':id/controlar')
  controlar(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthUser) {
    return this.cierre.controlar(id, actor);
  }

  /** Cierra la emergencia controlada (exige el Reporte Flash, el nivel y, en nivel 2 o 3, la investigación). */
  @RequirePermission(P.EMERGENCIAS_GESTIONAR)
  @Post(':id/cerrar')
  cerrar(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthUser) {
    return this.cierre.cerrar(id, actor);
  }
}
