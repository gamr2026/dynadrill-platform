import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Permission } from '@dyn/authz';
import { AuthUser, CurrentUser, RequirePermission } from '@dyn/common';
import type { EstadoUsoHerramienta } from '../generated/client';
import { BitacoraService } from '../services/bitacora.service';
import { EjecucionService } from '../services/ejecucion.service';
import { UsoHerramientasService } from '../services/uso-herramientas.service';

const P = Permission;
const HORA = /^([01]\d|2[0-3]):[0-5]\d$/;
const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const ESTADOS = ['operacion', 'stand_by', 'daily_charge', 'venta'];

export class ActaDto {
  @Matches(FECHA, { message: 'La fecha debe ser yyyy-MM-dd' }) fecha!: string;
}

export class ActividadDto {
  @Matches(HORA, { message: 'La hora de inicio debe ser HH:mm' }) horaInicio!: string;
  @Matches(HORA, { message: 'La hora de fin debe ser HH:mm' }) horaFin!: string;
  @IsString() @MaxLength(4000) detalle!: string;
}

export class GuardarBitacoraDto {
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => ActividadDto)
  actividades!: ActividadDto[];
}

export class PickerDto {
  /** Venta: tipo de completación. */
  @IsOptional() @IsUUID() tipoCompletacionId?: string;
  /** Servicios: tipo de trabajo. */
  @IsOptional() @IsUUID() tipoTrabajoId?: string;
  @IsUUID() tipoPickerId!: string;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(99999999) presion!: number;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(99999999) peso!: number;
  @IsOptional() @IsString() @MaxLength(500) observacion?: string;
}

export class RegistrarUsoDto {
  @IsIn(ESTADOS) estado!: EstadoUsoHerramienta;
  @IsOptional() @ValidateNested() @Type(() => PickerDto) picker?: PickerDto;
}

export class ConfirmarListadoUsoDto {
  @IsBoolean() confirmado!: boolean;
}

export class RechazarReportesDto {
  @IsString() @MinLength(3) @MaxLength(500) motivo!: string;
}

/** Reunión operativa, bitácora diaria, uso de herramientas, finalización de la ejecución y revisión de reportes de un ticket de FCR. */
@Controller('operaciones/fcr/tickets/:id')
export class EjecucionController {
  constructor(
    private readonly ejecucion: EjecucionService,
    private readonly bitacora: BitacoraService,
    private readonly uso: UsoHerramientasService,
  ) {}

  @RequirePermission(P.FCR_OPERAR)
  @Get('reunion-operativa')
  reunion(@Param('id', ParseUUIDPipe) id: string) {
    return this.ejecucion.reunion(id);
  }

  @RequirePermission(P.FCR_OPERAR)
  @Put('reunion-operativa')
  confirmarActa(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ActaDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.ejecucion.confirmarActa(id, dto.fecha, actor);
  }

  // ── bitácora ──
  @RequirePermission(P.FCR_OPERAR)
  @Get('bitacora')
  listarBitacora(@Param('id', ParseUUIDPipe) id: string) {
    return this.bitacora.listar(id);
  }

  @RequirePermission(P.FCR_OPERAR)
  @Get('bitacora/:fecha')
  obtenerBitacora(@Param('id', ParseUUIDPipe) id: string, @Param('fecha') fecha: string) {
    return this.bitacora.obtener(id, fecha);
  }

  /** Guarda las actividades del día (reemplaza las anteriores; si el día ya se envió, se reenvía solo). */
  @RequirePermission(P.FCR_OPERAR)
  @Put('bitacora/:fecha')
  guardarBitacora(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('fecha') fecha: string,
    @Body() dto: GuardarBitacoraDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.bitacora.guardar(id, fecha, dto.actividades, actor);
  }

  /** Envía el día a Facturación como Reporte Job; reenviar no duplica. */
  @RequirePermission(P.FCR_OPERAR)
  @Post('bitacora/:fecha/enviar')
  enviarBitacora(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('fecha') fecha: string,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.bitacora.enviar(id, fecha, actor);
  }

  // ── uso de herramientas ──
  @RequirePermission(P.FCR_OPERAR)
  @Get('uso-herramientas')
  listarUso(@Param('id', ParseUUIDPipe) id: string) {
    return this.uso.listar(id);
  }

  @RequirePermission(P.FCR_OPERAR)
  @Put('uso-herramientas/:herramientaId/:fecha')
  registrarUso(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('herramientaId', ParseUUIDPipe) herramientaId: string,
    @Param('fecha') fecha: string,
    @Body() dto: RegistrarUsoDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.uso.registrar(id, herramientaId, fecha, dto.estado, dto.picker, actor);
  }

  @RequirePermission(P.FCR_OPERAR)
  @Delete('uso-herramientas/:usoId')
  quitarUso(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('usoId', ParseUUIDPipe) usoId: string,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.uso.quitar(id, usoId, actor);
  }

  @RequirePermission(P.FCR_OPERAR)
  @Post('uso-herramientas/confirmar-listado')
  confirmarListadoUso(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ConfirmarListadoUsoDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.uso.confirmarListado(id, dto.confirmado, actor);
  }

  // ── finalizar y revisar ──
  @RequirePermission(P.FCR_OPERAR)
  @Post('finalizar-ejecucion')
  finalizar(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthUser) {
    return this.ejecucion.finalizar(id, actor);
  }

  @RequirePermission(P.FCR_OPERAR)
  @Post('aprobar-reportes')
  aprobar(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthUser) {
    return this.ejecucion.aprobarReportes(id, actor);
  }

  @RequirePermission(P.FCR_OPERAR)
  @Post('rechazar-reportes')
  rechazar(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RechazarReportesDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.ejecucion.rechazarReportes(id, dto.motivo, actor);
  }
}
