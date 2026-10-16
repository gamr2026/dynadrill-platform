import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Permission } from '@dyn/authz';
import { AuthUser, CurrentUser, RequirePermission } from '@dyn/common';
import { AsignacionService } from '../services/asignacion.service';
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
}

/** Tickets de servicio de Pumping: la bandeja del Jefe de Base, el Supervisor y el Operador. */
@Controller('operaciones/pumping')
export class TicketsController {
  constructor(
    private readonly tickets: TicketsService,
    private readonly asignacion: AsignacionService,
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
}
