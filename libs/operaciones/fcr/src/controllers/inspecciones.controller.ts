import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
} from '@nestjs/common';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
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
import type { ResponsableTrabajo, ResultadoParte, RolFirmaInspeccion } from '../generated/client';
import { InspeccionesService } from '../services/inspecciones.service';

const P = Permission;
const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const RESPONSABLES = ['dynadrill', 'proveedor_externo'];
const RESULTADOS = ['ok', 'defectuoso'];
const FIRMAS = ['reparado_por', 'revisado_por', 'liberado_qhse'];

export class EncabezadoDto {
  @IsOptional()
  @Matches(FECHA, { message: 'La fecha debe ser yyyy-MM-dd' })
  fechaInspeccion?: string;
  @IsOptional() @Matches(FECHA, { message: 'La fecha debe ser yyyy-MM-dd' }) fechaEnvio?: string;
  @IsOptional() @IsIn(RESPONSABLES) inspeccionadoPor?: ResponsableTrabajo;
  @IsOptional() @IsIn(RESPONSABLES) reparadoPor?: ResponsableTrabajo;
  @IsOptional() @IsString() @MaxLength(2000) observaciones?: string;
  @IsOptional() @IsString() @MaxLength(100) numeroSerie?: string;
}

export class ParteResultadoDto {
  @IsOptional() @IsIn(RESULTADOS) visual?: ResultadoParte;
  @IsOptional() @IsIn(RESULTADOS) endResultado?: ResultadoParte;
  @IsOptional() @IsInt() @Min(0) @Max(999) cambioCantidad?: number;
  @IsOptional() @IsString() @MaxLength(500) accion?: string;
}

export class ParteNuevaDto {
  @IsString() @MinLength(1) @MaxLength(300) descripcion!: string;
  @IsOptional() @IsString() @MaxLength(100) codigo?: string;
  @IsOptional() @IsInt() @Min(1) @Max(999) cantidadEsperada?: number;
}

export class RechazarInspeccionDto {
  @IsString() @MinLength(3) @MaxLength(500) motivo!: string;
  /** Las herramientas cuya inspección se rechaza; sin lista, todas las enviadas. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsUUID(undefined, { each: true })
  herramientaIds?: string[];
}

/** Inspección y reparación de herramientas de un ticket de SERVICIOS, con su aprobación por el Supervisor de Operaciones FCR. */
@Controller('operaciones/fcr/tickets/:id')
export class InspeccionesController {
  constructor(private readonly inspecciones: InspeccionesService) {}

  @RequirePermission(P.FCR_OPERAR)
  @Get('inspecciones')
  listar(@Param('id', ParseUUIDPipe) id: string) {
    return this.inspecciones.listar(id);
  }

  @RequirePermission(P.FCR_OPERAR)
  @Get('inspecciones/:inspeccionId')
  obtener(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('inspeccionId', ParseUUIDPipe) inspeccionId: string,
  ) {
    return this.inspecciones.obtener(id, inspeccionId);
  }

  /** Inicia (o continúa) la inspección de una herramienta; copia las partes del artículo. */
  @RequirePermission(P.FCR_OPERAR)
  @Post('herramientas/:herramientaId/inspeccion')
  iniciar(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('herramientaId', ParseUUIDPipe) herramientaId: string,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.inspecciones.iniciar(id, herramientaId, actor);
  }

  @RequirePermission(P.FCR_OPERAR)
  @Put('inspecciones/:inspeccionId')
  guardarEncabezado(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('inspeccionId', ParseUUIDPipe) inspeccionId: string,
    @Body() dto: EncabezadoDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.inspecciones.guardarEncabezado(id, inspeccionId, dto, actor);
  }

  @RequirePermission(P.FCR_OPERAR)
  @Put('inspecciones/:inspeccionId/partes/:parteId')
  guardarParte(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('inspeccionId', ParseUUIDPipe) inspeccionId: string,
    @Param('parteId', ParseUUIDPipe) parteId: string,
    @Body() dto: ParteResultadoDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.inspecciones.guardarParte(id, inspeccionId, parteId, dto, actor);
  }

  @RequirePermission(P.FCR_OPERAR)
  @Post('inspecciones/:inspeccionId/partes')
  agregarParte(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('inspeccionId', ParseUUIDPipe) inspeccionId: string,
    @Body() dto: ParteNuevaDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.inspecciones.agregarParte(id, inspeccionId, dto, actor);
  }

  @RequirePermission(P.FCR_OPERAR)
  @Delete('inspecciones/:inspeccionId/partes/:parteId')
  quitarParte(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('inspeccionId', ParseUUIDPipe) inspeccionId: string,
    @Param('parteId', ParseUUIDPipe) parteId: string,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.inspecciones.quitarParte(id, inspeccionId, parteId, actor);
  }

  @RequirePermission(P.FCR_OPERAR)
  @Post('inspecciones/:inspeccionId/firmas/:rol')
  firmar(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('inspeccionId', ParseUUIDPipe) inspeccionId: string,
    @Param('rol') rol: string,
    @CurrentUser() actor: AuthUser,
  ) {
    if (!FIRMAS.includes(rol)) throw new BadRequestException('La firma indicada no existe');
    return this.inspecciones.firmar(id, inspeccionId, rol as RolFirmaInspeccion, actor);
  }

  @RequirePermission(P.FCR_OPERAR)
  @Post('inspecciones/:inspeccionId/enviar')
  enviar(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('inspeccionId', ParseUUIDPipe) inspeccionId: string,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.inspecciones.enviar(id, inspeccionId, actor);
  }

  /** El Supervisor de Operaciones FCR aprueba las inspecciones; el ticket pasa a la preparación de herramientas. */
  @RequirePermission(P.FCR_OPERAR)
  @Post('aprobar-inspecciones')
  aprobar(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthUser) {
    return this.inspecciones.aprobar(id, actor);
  }

  @RequirePermission(P.FCR_OPERAR)
  @Post('rechazar-inspecciones')
  rechazar(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RechazarInspeccionDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.inspecciones.rechazar(id, dto.motivo, dto.herramientaIds, actor);
  }
}
