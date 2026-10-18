import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Permission } from '@dyn/authz';
import { AuthUser, CurrentUser, RequirePermission } from '@dyn/common';
import { AsignacionService } from '../services/asignacion.service';
import { QuimicosService } from '../services/quimicos.service';
import { RevisionSalidaService } from '../services/revision-salida.service';
import { TicketsService } from '../services/tickets.service';

const P = Permission;

export class AvanzarTicketDto {
  @IsString() @MinLength(1) @MaxLength(60) hacia!: string;
  @IsOptional() @IsString() @MaxLength(500) motivo?: string;
}

export class ListarTicketsDto {
  @IsOptional() @IsString() @MaxLength(60) paso?: string;
  /** `mios=true`: solo los tickets cuyo paso atiende el rol de quien consulta. */
  @IsOptional() @IsString() mios?: string;
  @IsOptional() @IsString() @MaxLength(100) q?: string;
}

export class OperadorUnidadDto {
  /** Cuenta del operador (rol operador). */
  @IsUUID() usuarioId!: string;
  /** Vehículo del catálogo que lleva este operador. */
  @IsUUID() vehiculoId!: string;
}

/** Un químico: de qué bodega sale (o a cuál vuelve) y cuánto. */
export class QuimicoDto {
  @IsUUID() articuloId!: string;
  @IsUUID() bodegaId!: string;
  @IsNumber({ maxDecimalPlaces: 3 }) @Min(0.001) @Max(99999999) cantidad!: number;
}

export class ConsumoQuimicoDto {
  @IsUUID() articuloId!: string;
  @IsNumber({ maxDecimalPlaces: 3 }) @Min(0.001) @Max(99999999) cantidad!: number;
}

export class DevolucionQuimicosDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => QuimicoDto)
  lineas!: QuimicoDto[];
}

export class AsignarTicketDto {
  /** Cuenta del supervisor (rol supervisor o supervisor_pumping). */
  @IsUUID() supervisorId!: string;
  /** Cada operador con su unidad. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => OperadorUnidadDto)
  operadores!: OperadorUnidadDto[];
  /** Químicos que salen de bodega a cargo del ticket (opcional). */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => QuimicoDto)
  quimicos?: QuimicoDto[];
  /** Archivo del documento de mezcla: obligatorio si hay químicos. */
  @IsOptional() @IsUUID() documentoMezclaId?: string;
}

/** Tickets de servicio de Pumping: la bandeja del Jefe de Base, el Supervisor y el Operador. */
@Controller('operaciones/pumping')
export class TicketsController {
  constructor(
    private readonly tickets: TicketsService,
    private readonly asignacion: AsignacionService,
    private readonly quimicos: QuimicosService,
    private readonly revisionSalida: RevisionSalidaService,
  ) {}

  @RequirePermission(P.PUMPING_OPERAR)
  @Get('tickets')
  listar(@Query() q: ListarTicketsDto, @CurrentUser() actor: AuthUser) {
    return this.tickets.listar({
      paso: q.paso,
      q: q.q,
      ...(q.mios === 'true' ? { rol: actor.roleCode, usuarioId: actor.id } : {}),
    });
  }

  @RequirePermission(P.PUMPING_OPERAR)
  @Get('tickets/:id')
  detalle(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthUser) {
    return this.tickets.detalle(id, actor);
  }

  @RequirePermission(P.PUMPING_OPERAR)
  @Post('tickets/:id/avanzar')
  avanzar(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AvanzarTicketDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.tickets.avanzar(id, dto.hacia, actor, dto.motivo);
  }

  /** El Jefe de Base asigna supervisor, operadores y unidades; el ticket pasa a Traslado de salida y se avisa a los elegidos. */
  @RequirePermission(P.PUMPING_OPERAR)
  @Post('tickets/:id/asignar')
  asignar(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AsignarTicketDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.asignacion.asignar(id, dto, actor);
  }

  /** El Supervisor del equipo aprueba la inspección de una unidad al revisar los reportes de salida. */
  @RequirePermission(P.PUMPING_OPERAR)
  @Post('tickets/:id/revision-salida/inspecciones/:vehiculoId/aprobar')
  aprobarInspeccion(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('vehiculoId', ParseUUIDPipe) vehiculoId: string,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.revisionSalida.aprobarInspeccion(id, vehiculoId, actor);
  }

  /** Químicos del ticket (asignado, usado, devuelto y pendiente) y su documento de mezcla. */
  @RequirePermission(P.PUMPING_OPERAR)
  @Get('tickets/:id/quimicos')
  quimicosDelTicket(@Param('id', ParseUUIDPipe) id: string) {
    return this.quimicos.detalle(id);
  }

  /** El Operador registra lo usado de un químico en la ejecución. */
  @RequirePermission(P.PUMPING_OPERAR)
  @Post('tickets/:id/quimicos/consumo')
  consumirQuimico(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ConsumoQuimicoDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.quimicos.consumir(id, dto.articuloId, dto.cantidad, actor);
  }

  /** El Supervisor devuelve a bodega lo que sobró, en el control de retorno. */
  @RequirePermission(P.PUMPING_OPERAR)
  @Post('tickets/:id/quimicos/devolucion')
  devolverQuimicos(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DevolucionQuimicosDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.quimicos.devolver(id, dto.lineas, actor);
  }
}
