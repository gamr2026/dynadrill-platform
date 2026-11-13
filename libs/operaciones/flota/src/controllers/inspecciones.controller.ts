import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
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
import { ConductoresService } from '../services/conductores.service';
import { InspeccionesService } from '../services/inspecciones.service';
import { TareasHoyConductorService } from '../services/tareas-hoy.service';

const P = Permission;
const actorDe = (u: AuthUser) => ({ id: u.id, roleCode: u.roleCode });
const MOMENTOS = ['salida', 'llegada'] as const;
const RESULTADOS = ['cumple', 'no_cumple', 'no_aplica'] as const;
const FECHA = /^\d{4}-\d{2}-\d{2}$/;

export class ResultadoItemDto {
  @IsUUID() itemId!: string;
  @IsIn(RESULTADOS) resultado!: (typeof RESULTADOS)[number];
}

export class RegistrarInspeccionDto {
  /** Caso del ticket; sin caso, indique `unidadId` (inspección suelta). */
  @IsOptional() @IsUUID() casoId?: string;
  @IsOptional() @IsUUID() unidadId?: string;
  @IsOptional() @IsIn(MOMENTOS) momento?: (typeof MOMENTOS)[number];
  /** Momento de la inspección (ISO 8601); por omisión, ahora. */
  @IsOptional() @IsString() @MaxLength(40) fecha?: string;
  /** Día del servicio (AAAA-MM-DD) al que pertenece; por omisión, el día de Ecuador de `fecha`. */
  @IsOptional() @Matches(FECHA) diaServicio?: string;
  /** Punto de partida (obligatorio) y destino (opcional): texto libre. */
  @IsString() @MinLength(1) @MaxLength(200) puntoPartida!: string;
  @IsOptional() @IsString() @MaxLength(200) destino?: string | null;
  @IsUUID() conductorId!: string;
  /** Lectura del odómetro al momento de la inspección. */
  @IsNumber() @Min(0) @Max(100000000) km!: number;
  @IsOptional() @IsString() @MaxLength(1000) observaciones?: string | null;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ResultadoItemDto)
  resultados!: ResultadoItemDto[];
}

export class ListarInspeccionesDto {
  @IsOptional() @IsUUID() ticketId?: string;
  @IsOptional() @IsUUID() unidadId?: string;
  @IsOptional() @IsUUID() conductorId?: string;
  @IsOptional() @IsIn(MOMENTOS) momento?: (typeof MOMENTOS)[number];
  @IsOptional() @IsIn(['true', 'false']) incluirAnuladas?: 'true' | 'false';
}

export class MisCasosDto {
  /** Día del servicio (AAAA-MM-DD): el estado de cada unidad ese día; sin él, el del día más reciente. */
  @IsOptional() @Matches(FECHA) dia?: string;
}

export class CasosDto {
  @IsUUID() ticketId!: string;
  /** Día del servicio (AAAA-MM-DD): el estado de cada unidad ese día; sin él, el del día más reciente. */
  @IsOptional() @Matches(FECHA) dia?: string;
}

export class MotivoDto {
  @IsString() @MinLength(5) @MaxLength(500) motivo!: string;
}

export class RegistrarPermisoDto {
  @IsUUID() tipoId!: string;
  @IsOptional() @Matches(FECHA) vigenteHasta?: string | null;
  @IsOptional() @IsUUID() archivoId?: string | null;
  @IsOptional() @IsString() @MaxLength(500) observaciones?: string | null;
}

export class ListarConductoresDto {
  @IsOptional() @IsString() @MaxLength(100) q?: string;
}

/** Inspección de vehículos (DYN-SGI-RE-068) y documentos de los conductores. */
@Controller('operaciones/flota')
export class InspeccionesController {
  constructor(
    private readonly inspecciones: InspeccionesService,
    private readonly conductores: ConductoresService,
    private readonly tareas: TareasHoyConductorService,
  ) {}

  // ---- inspecciones
  @RequirePermission(P.INSPECCIONES_VER)
  @Get('inspecciones-vehiculo/items')
  items() {
    return this.inspecciones.items();
  }

  @RequirePermission(P.INSPECCIONES_VER)
  @Get('inspecciones-vehiculo/casos')
  casos(@Query() q: CasosDto) {
    return this.inspecciones.casosDeTicket(q.ticketId, q.dia);
  }

  /** «Mis traslados de hoy» del Conductor: inspección y gerenciamiento de viaje de salida y de regreso de cada unidad que lleva. */
  @RequirePermission(P.INSPECCIONES_VER)
  @Get('mis-tareas-hoy')
  misTareasHoy(@CurrentUser() u: AuthUser) {
    return this.tareas.delUsuario(u);
  }

  @RequirePermission(P.INSPECCIONES_VER)
  @Get('inspecciones-vehiculo/mis-casos')
  misCasos(@CurrentUser() u: AuthUser, @Query() q: MisCasosDto) {
    return this.inspecciones.casosDeOperador(u.id, q.dia);
  }

  @RequirePermission(P.INSPECCIONES_VER, P.EXPEDIENTE_VER)
  @Get('inspecciones-vehiculo')
  listar(@Query() q: ListarInspeccionesDto, @CurrentUser() u: AuthUser) {
    // Con solo el permiso del expediente (Facturación) se consulta por ticket, no el listado general.
    if (!q.ticketId && !u.permissions.includes(P.INSPECCIONES_VER)) {
      throw new ForbiddenException('Indique el ticket de las inspecciones que quiere ver');
    }
    return this.inspecciones.listar({
      ticketId: q.ticketId,
      unidadId: q.unidadId,
      conductorId: q.conductorId,
      momento: q.momento,
      incluirAnuladas: q.incluirAnuladas === 'true',
    });
  }

  @RequirePermission(P.INSPECCIONES_VER, P.EXPEDIENTE_VER)
  @Get('inspecciones-vehiculo/:id')
  async obtener(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser) {
    const inspeccion = await this.inspecciones.obtener(id);
    // Con solo el permiso del expediente se ven las inspecciones que pertenecen a un ticket.
    if (!u.permissions.includes(P.INSPECCIONES_VER) && !inspeccion.caso?.ticketId) {
      throw new ForbiddenException('No tiene permiso para ver esta inspección');
    }
    return inspeccion;
  }

  @RequirePermission(P.INSPECCIONES_CREAR)
  @Post('inspecciones-vehiculo')
  registrar(@Body() dto: RegistrarInspeccionDto, @CurrentUser() u: AuthUser) {
    return this.inspecciones.registrar(
      { ...dto, fecha: dto.fecha ? new Date(dto.fecha) : undefined },
      actorDe(u),
    );
  }

  @RequirePermission(P.INSPECCIONES_APROBAR)
  @Post('inspecciones-vehiculo/:id/aprobar')
  aprobar(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser) {
    return this.inspecciones.aprobar(id, actorDe(u));
  }

  @RequirePermission(P.INSPECCIONES_APROBAR)
  @Post('inspecciones-vehiculo/:id/rechazar')
  rechazar(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MotivoDto,
    @CurrentUser() u: AuthUser,
  ) {
    return this.inspecciones.rechazar(id, dto.motivo, actorDe(u));
  }

  @RequirePermission(P.INSPECCIONES_ANULAR)
  @Post('inspecciones-vehiculo/:id/anular')
  anular(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MotivoDto,
    @CurrentUser() u: AuthUser,
  ) {
    return this.inspecciones.anular(id, dto.motivo, actorDe(u));
  }

  // ---- conductores y sus documentos
  @RequirePermission(P.CONDUCTORES_VER)
  @Get('conductores/tipos-permiso')
  tiposPermiso() {
    return this.conductores.tipos();
  }

  @RequirePermission(P.CONDUCTORES_VER)
  @Get('conductores')
  listarConductores(@Query() q: ListarConductoresDto) {
    return this.conductores.listar(q.q);
  }

  @RequirePermission(P.CONDUCTORES_VER)
  @Get('conductores/:usuarioId')
  estado(@Param('usuarioId', ParseUUIDPipe) usuarioId: string) {
    return this.conductores.detalle(usuarioId);
  }

  @RequirePermission(P.CONDUCTORES_VER)
  @Get('conductores/:usuarioId/permisos')
  historia(@Param('usuarioId', ParseUUIDPipe) usuarioId: string) {
    return this.conductores.historia(usuarioId);
  }

  @RequirePermission(P.CONDUCTORES_GESTIONAR)
  @Post('conductores/:usuarioId/permisos')
  registrarPermiso(
    @Param('usuarioId', ParseUUIDPipe) usuarioId: string,
    @Body() dto: RegistrarPermisoDto,
    @CurrentUser() u: AuthUser,
  ) {
    return this.conductores.registrar(usuarioId, dto, actorDe(u));
  }

  @RequirePermission(P.CONDUCTORES_GESTIONAR)
  @Post('conductores/permisos/:permisoId/anular')
  anularPermiso(
    @Param('permisoId', ParseUUIDPipe) permisoId: string,
    @Body() dto: MotivoDto,
    @CurrentUser() u: AuthUser,
  ) {
    return this.conductores.anular(permisoId, dto.motivo, actorDe(u));
  }
}
