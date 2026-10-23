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
import { CatalogosService } from '../services/catalogos.service';
import { DisponibilidadService } from '../services/disponibilidad.service';
import { RequisitosService } from '../services/requisitos.service';
import { TicketsService } from '../services/tickets.service';
import { TipoOperadorService } from '../services/tipo-operador.service';

const P = Permission;

export class AvanzarTicketDto {
  @IsString() @MinLength(1) @MaxLength(60) hacia!: string;
  @IsOptional() @IsString() @MaxLength(500) motivo?: string;
  /** Obligatorio al cerrar (`hacia = 'cerrado'`): el correo del cliente al que se envía la encuesta de satisfacción. */
  @IsOptional() @IsString() @MaxLength(254) correoCliente?: string;
}

export class ListarTicketsDto {
  @IsOptional() @IsString() @MaxLength(60) paso?: string;
  /** `mios=true`: solo los tickets cuyo paso atiende el rol de quien consulta (y, si el paso lo exige, de su equipo). */
  @IsOptional() @IsString() mios?: string;
  @IsOptional() @IsString() @MaxLength(100) q?: string;
}

export class TipoOperadorDto {
  @IsUUID() tipoOperadorId!: string;
  /** Cuenta del operador FCR que repara e inspecciona las herramientas. */
  @IsUUID() inspectorId!: string;
}

export class OperadorAsignadoDto {
  /** Cuenta del operador (rol operador_fcr). */
  @IsUUID() usuarioId!: string;
  /** Vehículo del catálogo que lleva este operador (opcional: no todo servicio lleva vehículo). */
}

export class AsignarTicketDto {
  /** Cuenta del supervisor (rol supervisor). Solo hace falta si el ticket aún no tiene supervisor. */
  @IsOptional() @IsUUID() supervisorId?: string;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => OperadorAsignadoDto)
  operadores!: OperadorAsignadoDto[];
}

export class DisponibilidadQueryDto {
  /** Inicio del rango (AAAA-MM-DD). Sin él se usa el servicio del ticket. */
  @IsOptional() @IsString() @MaxLength(10) desde?: string;
  /** Fin del rango (AAAA-MM-DD). Con solo `desde`, el rango es de ese día. */
  @IsOptional() @IsString() @MaxLength(10) hasta?: string;
}

export class CumplirRequisitoDto {
  @IsString() @MinLength(5) @MaxLength(500) motivo!: string;
}

/** Tickets de servicio de FCR: la bandeja del Supervisor, el Operador FCR, el Supervisor de Operaciones y Bodega. */
@Controller('operaciones/fcr')
export class TicketsController {
  constructor(
    private readonly tickets: TicketsService,
    private readonly asignacion: AsignacionService,
    private readonly tipoOperador: TipoOperadorService,
    private readonly catalogos: CatalogosService,
    private readonly requisitos: RequisitosService,
    private readonly disponibilidad: DisponibilidadService,
  ) {}

  /** Tipos de operador, de completación, de trabajo y de picker. */
  @RequirePermission(P.FCR_OPERAR)
  @Get('catalogos')
  catalogosFcr() {
    return this.catalogos.todos();
  }

  @RequirePermission(P.FCR_OPERAR)
  @Get('tickets')
  listar(@Query() q: ListarTicketsDto, @CurrentUser() actor: AuthUser) {
    return this.tickets.listar({
      paso: q.paso,
      q: q.q,
      ...(q.mios === 'true' ? { rol: actor.roleCode, usuarioId: actor.id } : {}),
    });
  }

  @RequirePermission(P.FCR_OPERAR)
  @Get('tickets/:id')
  detalle(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthUser) {
    return this.tickets.detalle(id, actor);
  }

  @RequirePermission(P.FCR_OPERAR)
  @Post('tickets/:id/avanzar')
  avanzar(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AvanzarTicketDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.tickets.avanzar(id, dto.hacia, actor, dto.motivo, dto.correoCliente);
  }

  /** Entrada SERVICIOS: el Supervisor elige el tipo de operador y quién repara e inspecciona. */
  @RequirePermission(P.FCR_OPERAR)
  @Post('tickets/:id/tipo-operador')
  definirTipoOperador(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TipoOperadorDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.tipoOperador.definir(id, dto.tipoOperadorId, dto.inspectorId, actor);
  }

  /** Cada operador con ✓/✗ frente al rango (por defecto, el servicio del ticket), para la pantalla de asignación. */
  @RequirePermission(P.FCR_OPERAR)
  @Get('tickets/:id/operadores-disponibles')
  operadoresDisponibles(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() q: DisponibilidadQueryDto,
  ) {
    return this.disponibilidad.operadores(id, q.desde, q.hasta);
  }

  /** El Supervisor asigna a los operadores; el ticket pasa a la reunión operativa. */
  @RequirePermission(P.FCR_OPERAR)
  @Post('tickets/:id/asignar')
  asignar(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AsignarTicketDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.asignacion.asignar(id, dto, actor);
  }

  /** PUENTE TEMPORAL: confirma a mano un requisito de otro módulo que aún no publica su evento. Exige motivo. */
  @RequirePermission(P.FCR_REQUISITOS_PUENTE)
  @Post('requisitos/:requisitoId/cumplir')
  async cumplirRequisito(
    @Param('requisitoId', ParseUUIDPipe) requisitoId: string,
    @Body() dto: CumplirRequisitoDto,
    @CurrentUser() actor: AuthUser,
  ) {
    await this.requisitos.cumplirManual(requisitoId, dto.motivo, actor.id);
    return { ok: true };
  }
}
