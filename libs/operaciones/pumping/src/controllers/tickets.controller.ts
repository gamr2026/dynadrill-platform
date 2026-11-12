import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
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
import { AsignacionService } from '../services/asignacion.service';
import { ResponsableService } from '../services/responsable.service';
import { DisponibilidadService } from '../services/disponibilidad.service';
import { QuimicosService } from '../services/quimicos.service';
import { ROLES_COORDINA, TicketsService, type Bandeja } from '../services/tickets.service';
import { TicketNoAnuladoGuard } from '../guards/ticket-no-anulado.guard';

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
  /** Por responsable: `mias`, `sin_asignar` o `todas` (por omisión: no cambia lo que se ve). */
  @IsOptional() @IsIn(['mias', 'sin_asignar', 'todas']) bandeja?: Bandeja;
}

export class DisponibilidadQueryDto {
  /** Inicio del rango (AAAA-MM-DD). Sin él se usa el servicio del ticket. */
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) desde?: string;
  /** Fin del rango (AAAA-MM-DD). Con solo `desde`, el rango es de ese día. */
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) hasta?: string;
}

export class AsignarResponsableDto {
  /** Cuenta del Jefe de Base que queda como responsable. */
  @IsUUID() usuarioId!: string;
  /** Obligatorio al reemplazar a quien ya era responsable. */
  @IsOptional() @IsString() @MaxLength(500) motivo?: string;
}

export class LiberarResponsableDto {
  /** Obligatorio al liberar un ticket que es de otro. */
  @IsOptional() @IsString() @MaxLength(500) motivo?: string;
}

export class OperadorUnidadDto {
  /** Cuenta del operador (rol operador). */
  @IsUUID() usuarioId!: string;
  /** Unidad de Flota que lleva este operador (activa). */
  @IsUUID() unidadId!: string;
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
  /** Día del servicio (AAAA-MM-DD) en que se usó; por omisión, hoy. */
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) fecha?: string;
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
  /** El conductor de cada unidad (uno por unidad; cuenta con rol conductor). */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => OperadorUnidadDto)
  conductores!: OperadorUnidadDto[];
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
@UseGuards(TicketNoAnuladoGuard)
@Controller('operaciones/pumping')
export class TicketsController {
  constructor(
    private readonly tickets: TicketsService,
    private readonly asignacion: AsignacionService,
    private readonly quimicos: QuimicosService,
    private readonly responsable: ResponsableService,
    private readonly disponibilidad: DisponibilidadService,
  ) {}

  @RequirePermission(P.PUMPING_OPERAR)
  @Get('tickets')
  listar(@Query() q: ListarTicketsDto, @CurrentUser() actor: AuthUser) {
    return this.tickets.listar({
      paso: q.paso,
      q: q.q,
      bandeja: q.bandeja,
      consultaId: actor.id,
      ...(q.mios === 'true' ? { rol: actor.roleCode, usuarioId: actor.id } : {}),
    });
  }

  /** Tickets del operador que consulta, con los datos mínimos del viaje (los consume el portal del Conductor de Flota). */
  @RequirePermission(P.PUMPING_CONTEXTO_CONDUCTOR)
  @Get('tickets/mis-viajes')
  misViajes(@CurrentUser() actor: AuthUser) {
    return this.tickets.misViajes(actor.id);
  }

  @RequirePermission(P.PUMPING_OPERAR, P.PUMPING_VER)
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

  /** El Jefe de Base se queda con el ticket si nadie lo tiene (409 si ya tiene responsable). */
  @RequirePermission(P.PUMPING_OPERAR)
  @Post('tickets/:id/responsable/tomar')
  async tomar(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthUser) {
    await this.responsable.tomar(id, actor);
    return this.tickets.detalle(id, actor);
  }

  /** Asigna o reasigna el ticket a un Jefe de Base (motivo obligatorio si ya había responsable). */
  @RequirePermission(P.PUMPING_OPERAR)
  @Post('tickets/:id/responsable')
  async asignarResponsable(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AsignarResponsableDto,
    @CurrentUser() actor: AuthUser,
  ) {
    await this.responsable.asignar(id, dto.usuarioId, dto.motivo, actor);
    return this.tickets.detalle(id, actor);
  }

  /** Deja el ticket sin responsable. */
  @RequirePermission(P.PUMPING_OPERAR)
  @Post('tickets/:id/responsable/liberar')
  async liberarResponsable(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: LiberarResponsableDto,
    @CurrentUser() actor: AuthUser,
  ) {
    await this.responsable.liberar(id, dto.motivo, actor);
    return this.tickets.detalle(id, actor);
  }

  /** Quién ya está en otro ticket sin cerrar (con fechas que se cruzan): la asignación los muestra como no disponibles. */
  @RequirePermission(P.PUMPING_OPERAR)
  @Get('tickets/:id/personal-ocupado')
  personalOcupado(@Param('id', ParseUUIDPipe) id: string) {
    return this.asignacion.personalOcupado(id);
  }

  /** Quien ve la disponibilidad es quien puede asignar: el Jefe de Base y Superadmin. */
  private exigirCoordina(actor: AuthUser) {
    if (!ROLES_COORDINA.includes(actor.roleCode))
      throw new ForbiddenException('Solo el Jefe de Base puede ver la disponibilidad del personal');
  }

  /**
   * Cada supervisor, operador y conductor activo con `disponible` frente al rango (por omisión, el servicio del ticket) y, si no lo está, los
   * tickets que lo ocupan (número, pedido, cliente y fechas). Es la lista de la pantalla de asignación; la asignación aplica la misma regla.
   */
  @RequirePermission(P.PUMPING_OPERAR)
  @Get('tickets/:id/personal-disponible')
  personalDisponible(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() q: DisponibilidadQueryDto,
    @CurrentUser() actor: AuthUser,
  ) {
    this.exigirCoordina(actor);
    return this.disponibilidad.personal(id, q.desde, q.hasta);
  }

  /** Lo mismo para un rango explícito, sin ticket (`desde` obligatorio; `hasta` por omisión, el mismo día). */
  @RequirePermission(P.PUMPING_OPERAR)
  @Get('personal-disponible')
  personalDisponibleEnRango(@Query() q: DisponibilidadQueryDto, @CurrentUser() actor: AuthUser) {
    this.exigirCoordina(actor);
    return this.disponibilidad.personal(null, q.desde, q.hasta);
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
    return this.quimicos.consumir(id, dto.articuloId, dto.cantidad, actor, dto.fecha);
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
