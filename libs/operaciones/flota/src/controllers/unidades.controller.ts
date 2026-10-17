import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import {
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
} from 'class-validator';
import { Permission } from '@dyn/authz';
import { AuthUser, CurrentUser, RequirePermission } from '@dyn/common';
import { LecturasService } from '../services/lecturas.service';
import { PreventivosService } from '../services/preventivos.service';
import { ProveedoresService } from '../services/proveedores.service';
import { UnidadesService } from '../services/unidades.service';

const P = Permission;
const TIPOS = ['servicio', 'auxiliar', 'transporte'] as const;
const CATEGORIAS = ['pesado', 'liviano'] as const;
const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const actorDe = (u: AuthUser) => ({ id: u.id, roleCode: u.roleCode });

// En los DTO de cambios, `null` borra el dato y omitir el campo lo deja como está (`@IsOptional` acepta ambos).

export class ListarUnidadesDto {
  @IsOptional() @IsIn(TIPOS) tipo?: (typeof TIPOS)[number];
  /** `true` (por omisión), `false` o `todas`. */
  @IsOptional() @IsIn(['true', 'false', 'todas']) activa?: 'true' | 'false' | 'todas';
  @IsOptional() @IsString() @MaxLength(100) q?: string;
}

export class CrearUnidadDto {
  @IsString() @MinLength(2) @MaxLength(30) codigo!: string;
  @IsString() @MinLength(2) @MaxLength(120) nombre!: string;
  @IsIn(TIPOS) tipo!: (typeof TIPOS)[number];
  @IsOptional() @IsIn(CATEGORIAS) categoriaPeso?: (typeof CATEGORIAS)[number] | null;
  @IsOptional() @IsUUID() vehiculoId?: string | null;
  @IsOptional() @IsUUID() proveedorMantenimientoId?: string | null;
  @IsOptional() @Matches(FECHA) fechaMatricula?: string | null;
  @IsOptional() @Matches(FECHA) caducidadMatricula?: string | null;
  @IsOptional() @Matches(FECHA) caducidadPoliza?: string | null;
  @IsOptional() @Matches(FECHA) vigenciaOtroDocumento?: string | null;
  @IsOptional() @IsUUID() responsablePatrimonialId?: string | null;
  @IsOptional() @IsBoolean() predeterminada?: boolean;
  @IsOptional() @IsString() @MaxLength(1000) nota?: string | null;
  @IsOptional() @IsNumber() @Min(0) @Max(100000000) lecturaInicial?: number | null;
}

export class ActualizarUnidadDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(120) nombre?: string;
  @IsOptional() @IsIn(CATEGORIAS) categoriaPeso?: (typeof CATEGORIAS)[number] | null;
  @IsOptional() @IsUUID() vehiculoId?: string | null;
  @IsOptional() @IsUUID() proveedorMantenimientoId?: string | null;
  @IsOptional() @Matches(FECHA) fechaMatricula?: string | null;
  @IsOptional() @Matches(FECHA) caducidadMatricula?: string | null;
  @IsOptional() @Matches(FECHA) caducidadPoliza?: string | null;
  @IsOptional() @Matches(FECHA) vigenciaOtroDocumento?: string | null;
  @IsOptional() @IsUUID() responsablePatrimonialId?: string | null;
  @IsOptional() @IsBoolean() predeterminada?: boolean;
  @IsOptional() @IsString() @MaxLength(1000) nota?: string | null;
}

export class CambiarActivaDto {
  @IsBoolean() activa!: boolean;
}

export class ListarLecturasDto {
  @IsOptional() @IsIn(['horometro', 'odometro']) tipo?: 'horometro' | 'odometro';
  @IsOptional() @Matches(/^\d{1,3}$/) limite?: string;
}

export class RegistrarLecturaDto {
  @IsIn(['horometro', 'odometro']) tipo!: 'horometro' | 'odometro';
  @IsNumber() @Min(0) @Max(100000000) valor!: number;
  /** Momento de la lectura (ISO 8601); por omisión, ahora. */
  @IsOptional() @IsString() @MaxLength(40) leidaAt?: string;
}

export class RegistrarPreventivoDto {
  @IsOptional() @IsIn(['a', 'b']) tipoServicio?: 'a' | 'b' | null;
  @Matches(FECHA) fecha!: string;
  @IsOptional() @IsNumber() @Min(0) @Max(100000000) valor?: number | null;
  @IsIn(['interno', 'tercero']) ejecutadoPor!: 'interno' | 'tercero';
  @IsOptional() @IsUUID() proveedorMantenimientoId?: string | null;
  @IsOptional() @IsUUID() responsableId?: string | null;
  @IsOptional() @IsString() @MaxLength(1000) observaciones?: string | null;
  @IsOptional() @IsUUID() checklistArchivoId?: string | null;
}

export class AnularDto {
  /** Por qué se anula (queda en la historia). */
  @IsString() @MinLength(5) @MaxLength(500) motivo!: string;
}

export class AlertasDto {
  @IsOptional() @IsIn(['rojo', 'amarillo', 'verde']) nivel?: 'rojo' | 'amarillo' | 'verde';
}

export class CrearProveedorDto {
  @IsString() @MinLength(2) @MaxLength(150) nombre!: string;
}

export class ActualizarProveedorDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(150) nombre?: string;
  @IsOptional() @IsBoolean() activo?: boolean;
}

/** Unidades de Dynadrill, sus lecturas, sus preventivos y los proveedores de mantenimiento. */
@Controller('operaciones/flota')
export class UnidadesController {
  constructor(
    private readonly unidades: UnidadesService,
    private readonly lecturas: LecturasService,
    private readonly preventivos: PreventivosService,
    private readonly proveedores: ProveedoresService,
  ) {}

  @RequirePermission(P.UNIDADES_VER)
  @Get('unidades')
  listar(@Query() q: ListarUnidadesDto) {
    return this.unidades.listar({
      tipo: q.tipo,
      q: q.q,
      activa: q.activa === 'todas' ? 'todas' : q.activa === 'false' ? false : true,
    });
  }

  @RequirePermission(P.UNIDADES_VER)
  @Get('unidades/alertas')
  alertas(@Query() q: AlertasDto) {
    return this.preventivos.alertas({ nivel: q.nivel });
  }

  @RequirePermission(P.UNIDADES_VER)
  @Get('unidades/:id')
  obtener(@Param('id', ParseUUIDPipe) id: string) {
    return this.unidades.obtener(id);
  }

  @RequirePermission(P.UNIDADES_CREAR)
  @Post('unidades')
  crear(@Body() dto: CrearUnidadDto, @CurrentUser() u: AuthUser) {
    return this.unidades.crear(dto, actorDe(u));
  }

  @RequirePermission(P.UNIDADES_EDITAR)
  @Patch('unidades/:id')
  actualizar(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ActualizarUnidadDto,
    @CurrentUser() u: AuthUser,
  ) {
    return this.unidades.actualizar(id, dto, actorDe(u));
  }

  @RequirePermission(P.UNIDADES_INACTIVAR)
  @Patch('unidades/:id/activa')
  cambiarActiva(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CambiarActivaDto,
    @CurrentUser() u: AuthUser,
  ) {
    return this.unidades.cambiarActiva(id, dto.activa, actorDe(u));
  }

  // ---- lecturas
  @RequirePermission(P.UNIDADES_VER)
  @Get('unidades/:id/lecturas')
  listarLecturas(@Param('id', ParseUUIDPipe) id: string, @Query() q: ListarLecturasDto) {
    return this.lecturas.listar(id, q.tipo, q.limite ? Number(q.limite) : undefined);
  }

  @RequirePermission(P.LECTURAS_REGISTRAR)
  @Post('unidades/:id/lecturas')
  registrarLectura(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RegistrarLecturaDto,
    @CurrentUser() u: AuthUser,
  ) {
    const leidaAt = dto.leidaAt ? new Date(dto.leidaAt) : undefined;
    return this.lecturas.registrar(
      id,
      { tipo: dto.tipo, valor: dto.valor, leidaAt, fuente: 'manual' },
      actorDe(u),
    );
  }

  @RequirePermission(P.LECTURAS_ANULAR)
  @Post('lecturas/:lecturaId/anular')
  anularLectura(
    @Param('lecturaId', ParseUUIDPipe) lecturaId: string,
    @Body() dto: AnularDto,
    @CurrentUser() u: AuthUser,
  ) {
    return this.lecturas.anular(lecturaId, dto.motivo, actorDe(u));
  }

  // ---- preventivos
  @RequirePermission(P.UNIDADES_VER)
  @Get('unidades/:id/preventivos')
  listarPreventivos(@Param('id', ParseUUIDPipe) id: string) {
    return this.preventivos.listar(id);
  }

  @RequirePermission(P.PREVENTIVOS_REGISTRAR)
  @Post('unidades/:id/preventivos')
  registrarPreventivo(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RegistrarPreventivoDto,
    @CurrentUser() u: AuthUser,
  ) {
    return this.preventivos.registrar(id, dto, actorDe(u));
  }

  @RequirePermission(P.PREVENTIVOS_ANULAR)
  @Post('preventivos/:preventivoId/anular')
  anularPreventivo(
    @Param('preventivoId', ParseUUIDPipe) preventivoId: string,
    @Body() dto: AnularDto,
    @CurrentUser() u: AuthUser,
  ) {
    return this.preventivos.anular(preventivoId, dto.motivo, actorDe(u));
  }

  // ---- proveedores de mantenimiento
  @RequirePermission(P.UNIDADES_VER)
  @Get('proveedores-mantenimiento')
  listarProveedores() {
    return this.proveedores.listar(false);
  }

  @RequirePermission(P.PROVEEDORES_MANTENIMIENTO_GESTIONAR)
  @Post('proveedores-mantenimiento')
  crearProveedor(@Body() dto: CrearProveedorDto, @CurrentUser() u: AuthUser) {
    return this.proveedores.crear(dto.nombre, u.id);
  }

  @RequirePermission(P.PROVEEDORES_MANTENIMIENTO_GESTIONAR)
  @Patch('proveedores-mantenimiento/:id')
  actualizarProveedor(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ActualizarProveedorDto,
    @CurrentUser() u: AuthUser,
  ) {
    return this.proveedores.actualizar(id, dto, u.id);
  }
}
