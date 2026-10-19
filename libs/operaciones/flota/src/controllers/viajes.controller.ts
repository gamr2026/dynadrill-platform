import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
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
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Permission } from '@dyn/authz';
import { AuthUser, CurrentUser, RequirePermission } from '@dyn/common';
import { ViajesService } from '../services/viajes.service';

const P = Permission;
const TIPOS = ['salida', 'retorno'] as const;
const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const HORA = /^\d{2}:\d{2}$/;
const actorDe = (u: AuthUser) => ({ id: u.id, roleCode: u.roleCode, permissions: u.permissions });

export class ExtremoViajeDto {
  @IsOptional() @IsUUID() bodegaId?: string;
  @IsOptional() @IsUUID() pozoId?: string;
}

export class RespuestaRiesgoDto {
  @IsUUID() preguntaId!: string;
  @IsUUID() opcionId!: string;
}

export class ParadaDto {
  @IsString() @MinLength(2) @MaxLength(200) lugar!: string;
  @IsOptional() @Matches(HORA) horaLlegada?: string | null;
  @IsOptional() @Matches(HORA) horaSalida?: string | null;
  @IsOptional() @IsString() @MaxLength(300) detallePernocta?: string | null;
}

export class ComunicacionDto {
  @IsString() @MinLength(1) @MaxLength(100) frecuencia!: string;
  @IsString() @MinLength(2) @MaxLength(150) personaContacto!: string;
  @IsOptional() @IsString() @MaxLength(200) datosContacto?: string | null;
}

export class TelefonicaDto {
  @IsString() @MinLength(2) @MaxLength(150) de!: string;
  @Matches(HORA) hora!: string;
}

export class SolicitarViajeDto {
  @IsIn(TIPOS) tipo!: (typeof TIPOS)[number];
  /** Ticket de Pumping al que corresponde (obligatorio para que cuente como condición del ticket). */
  @IsOptional() @IsUUID() ticketId?: string;
  @IsUUID() unidadId!: string;
  @Matches(FECHA) fecha!: string;
  @IsString() @MinLength(3) @MaxLength(500) motivo!: string;
  @ValidateNested() @Type(() => ExtremoViajeDto) origen!: ExtremoViajeDto;
  @ValidateNested() @Type(() => ExtremoViajeDto) destino!: ExtremoViajeDto;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => RespuestaRiesgoDto)
  respuestas!: RespuestaRiesgoDto[];
  @IsOptional() @IsString() @MaxLength(500) pasajeros?: string | null;
  @IsOptional() @IsBoolean() puedeCombinarViajes?: boolean | null;
  @IsOptional() @Matches(HORA) horaSalida?: string | null;
  @IsOptional() @Matches(HORA) horaLlegada?: string | null;
  @IsOptional() @IsString() @MaxLength(500) datosPernocta?: string | null;
  @IsOptional()
  @ValidateNested()
  @Type(() => TelefonicaDto)
  aprobacionTelefonica?: TelefonicaDto | null;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => ParadaDto)
  paradas?: ParadaDto[];
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => ComunicacionDto)
  comunicaciones?: ComunicacionDto[];
}

export class ListarViajesDto {
  @IsOptional() @IsIn(['pendiente', 'autorizado', 'rechazado']) estado?:
    'pendiente' | 'autorizado' | 'rechazado';
  @IsOptional() @IsUUID() ticketId?: string;
  @IsOptional() @IsIn(TIPOS) tipo?: (typeof TIPOS)[number];
}

export class RechazarViajeDto {
  @IsString() @MinLength(5) @MaxLength(500) motivo!: string;
}

/** Gerenciamiento de Viaje (DYN-SGI-RE-049): lo solicita el Conductor y lo autorizan el Supervisor, el Jefe de Base o el Gerente HSE. */
@Controller('operaciones/flota/gerenciamientos-viaje')
export class ViajesController {
  constructor(private readonly viajes: ViajesService) {}

  @RequirePermission(P.VIAJES_SOLICITAR, P.VIAJES_APROBAR, P.VIAJES_AUTORIZAR_MAYOR)
  @Get('preguntas')
  preguntas() {
    return this.viajes.preguntas();
  }

  @RequirePermission(P.VIAJES_SOLICITAR, P.VIAJES_APROBAR, P.VIAJES_AUTORIZAR_MAYOR)
  @Get('umbrales')
  umbrales() {
    return this.viajes.umbrales();
  }

  @RequirePermission(P.VIAJES_SOLICITAR)
  @Get('unidades')
  unidades() {
    return this.viajes.unidades();
  }

  @RequirePermission(P.VIAJES_SOLICITAR)
  @Get('bodegas')
  bodegas() {
    return this.viajes.bodegas();
  }

  @RequirePermission(P.VIAJES_SOLICITAR, P.VIAJES_APROBAR, P.VIAJES_AUTORIZAR_MAYOR)
  @Get()
  listar(@Query() q: ListarViajesDto, @CurrentUser() u: AuthUser) {
    return this.viajes.listar(q, actorDe(u));
  }

  @RequirePermission(P.VIAJES_SOLICITAR, P.VIAJES_APROBAR, P.VIAJES_AUTORIZAR_MAYOR)
  @Get(':id')
  obtener(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser) {
    return this.viajes.obtener(id, actorDe(u));
  }

  @RequirePermission(P.VIAJES_SOLICITAR)
  @Post()
  solicitar(@Body() dto: SolicitarViajeDto, @CurrentUser() u: AuthUser) {
    return this.viajes.solicitar(dto, actorDe(u));
  }

  @RequirePermission(P.VIAJES_APROBAR, P.VIAJES_AUTORIZAR_MAYOR)
  @Post(':id/autorizar')
  autorizar(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser) {
    return this.viajes.autorizar(id, actorDe(u));
  }

  @RequirePermission(P.VIAJES_APROBAR, P.VIAJES_AUTORIZAR_MAYOR)
  @Post(':id/rechazar')
  rechazar(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RechazarViajeDto,
    @CurrentUser() u: AuthUser,
  ) {
    return this.viajes.rechazar(id, dto.motivo, actorDe(u));
  }
}
