import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
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
import { EstadoItemStop, EstadoStop } from '../generated/client';
import { StopConsultaService } from './stop-consulta.service';
import { StopService } from './stop.service';

const P = Permission;
const FECHA = /^\d{4}-\d{2}-\d{2}$/;

export class ItemMarcadoDto {
  @IsUUID() itemId!: string;
  @IsIn(Object.values(EstadoItemStop)) estado!: EstadoItemStop;
}

export class RegistrarStopDto {
  @IsOptional() @Matches(FECHA) fecha?: string;
  @IsOptional() @IsUUID() observadoId?: string;
  @IsOptional() @IsUUID() campoId?: string;
  @IsOptional() @IsUUID() operadoraId?: string;
  @IsOptional() @IsString() @MaxLength(500) lugar?: string;
  @IsOptional() @IsString() @MaxLength(200) contacto?: string;
  @IsOptional() @IsUUID() ticketId?: string;
  /** Foto subida antes a `/api/archivos` con el módulo `qhse_stop_foto`. */
  @IsOptional() @IsUUID() fotoArchivoId?: string;
  @IsOptional() @IsString() @MaxLength(2000) accionesQueObserva?: string;
  @IsOptional() @IsString() @MaxLength(2000) accionesAccion?: string;
  @IsOptional() @IsString() @MaxLength(2000) condicionesQueObserva?: string;
  @IsOptional() @IsString() @MaxLength(2000) condicionesAccion?: string;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(80)
  @ValidateNested({ each: true })
  @Type(() => ItemMarcadoDto)
  items!: ItemMarcadoDto[];
}

export class ListarStopDto {
  @IsOptional() @IsIn(Object.values(EstadoStop)) estado?: EstadoStop;
  @IsOptional() @Matches(FECHA) desde?: string;
  @IsOptional() @Matches(FECHA) hasta?: string;
  @IsOptional() @IsString() @MaxLength(100) q?: string;
}

export class TendenciasDto {
  @IsOptional() @Matches(FECHA) desde?: string;
  @IsOptional() @Matches(FECHA) hasta?: string;
}

export class DerivarStopDto {
  @IsIn(['mantenimiento', 'otro']) destino!: 'mantenimiento' | 'otro';
  @IsString() @MaxLength(1000) observacion!: string;
}

export class ObservacionStopDto {
  @IsString() @MaxLength(1000) observacion!: string;
}

/**
 * Tarjeta STOP. Ruta pública `/api/v2/qhse/stop`. Registrar (y el formato para llenarla) es de cualquier usuario autenticado
 * (`qhse.eventos.reportar`); la bandeja, las tendencias y la gestión son del equipo HSE.
 */
@Controller('qhse/stop')
export class StopController {
  constructor(
    private readonly stop: StopService,
    private readonly consulta: StopConsultaService,
  ) {}

  @RequirePermission(P.QHSE_REPORTAR)
  @Get('formato')
  formato() {
    return this.consulta.formato();
  }

  @RequirePermission(P.QHSE_REPORTAR)
  @Post()
  registrar(@Body() dto: RegistrarStopDto, @CurrentUser() actor: AuthUser) {
    return this.stop.registrar(dto, actor);
  }

  @RequirePermission(P.STOP_VER)
  @Get('tendencias')
  tendencias(@Query() q: TendenciasDto) {
    return this.consulta.tendencias(q.desde, q.hasta);
  }

  @RequirePermission(P.STOP_VER)
  @Get()
  listar(@Query() q: ListarStopDto) {
    return this.consulta.listar(q);
  }

  @RequirePermission(P.STOP_VER)
  @Get(':id')
  detalle(@Param('id', ParseUUIDPipe) id: string) {
    return this.consulta.detalle(id);
  }

  @RequirePermission(P.STOP_GESTIONAR)
  @Post(':id/derivar')
  derivar(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DerivarStopDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.stop.derivar(id, dto.destino, dto.observacion, actor);
  }

  @RequirePermission(P.STOP_GESTIONAR)
  @Post(':id/resolver')
  resolver(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ObservacionStopDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.stop.resolver(id, dto.observacion, actor);
  }

  @RequirePermission(P.STOP_GESTIONAR)
  @Post(':id/cerrar')
  cerrar(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthUser) {
    return this.stop.cerrar(id, actor);
  }
}
