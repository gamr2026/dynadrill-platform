import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
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
} from 'class-validator';
import { Permission } from '@dyn/authz';
import { AuthUser, CurrentUser, RequirePermission } from '@dyn/common';
import type { CausaFaltante } from '../generated/client';
import { ReporteUnidadLlegadaService } from '../services/reporte-unidad-llegada.service';
import { RetornoService } from '../services/retorno.service';

const P = Permission;

export class DevolverDto {
  /** Las herramientas que vuelven; sin lista, todas las recibidas que aún no tienen retorno. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsUUID(undefined, { each: true })
  herramientaIds?: string[];
}

export class FaltanteDto {
  @IsIn(['venta_complementaria', 'perdida', 'dano', 'otro']) causa!: CausaFaltante;
  @IsString() @MinLength(3) @MaxLength(500) detalle!: string;
}

export class LlegadaDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'La fecha debe ser yyyy-MM-dd' }) fecha!: string;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(999999) combustible!: number;
  @IsOptional() @IsString() @MaxLength(2000) novedadesMecanica?: string;
  @IsOptional() @IsString() @MaxLength(2000) novedadesInstrumentacion?: string;
  @IsOptional() @IsString() @MaxLength(2000) novedadesOperaciones?: string;
  @IsBoolean() unidadLista!: boolean;
  @IsBoolean() operacionInterrumpida!: boolean;
  @IsOptional() @IsString() @MaxLength(2000) detalleInterrupcion?: string;
}

/** Control de retorno: herramientas (Bodega) y reporte de unidad de llegada (operador de cada unidad). */
@Controller('operaciones/fcr')
export class RetornoController {
  constructor(
    private readonly retorno: RetornoService,
    private readonly llegada: ReporteUnidadLlegadaService,
  ) {}

  /** Lo que Bodega tiene por retornar, de todos los tickets en control de retorno. */
  @RequirePermission(P.FCR_HERRAMIENTAS_PREPARAR)
  @Get('herramientas/pendientes-de-retorno')
  pendientes() {
    return this.retorno.pendientes();
  }

  @RequirePermission(P.FCR_HERRAMIENTAS_PREPARAR)
  @Post('tickets/:id/herramientas/devolver')
  devolver(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DevolverDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.retorno.devolver(id, dto.herramientaIds, actor);
  }

  @RequirePermission(P.FCR_HERRAMIENTAS_PREPARAR)
  @Post('tickets/:id/herramientas/:herramientaId/faltante')
  faltante(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('herramientaId', ParseUUIDPipe) herramientaId: string,
    @Body() dto: FaltanteDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.retorno.faltante(id, herramientaId, dto.causa, dto.detalle, actor);
  }

  @RequirePermission(P.FCR_OPERAR)
  @Get('tickets/:id/reportes-unidad-llegada')
  listarLlegadas(@Param('id', ParseUUIDPipe) id: string) {
    return this.llegada.listar(id);
  }

  @RequirePermission(P.FCR_OPERAR)
  @Post('tickets/:id/reportes-unidad-llegada/:vehiculoId')
  firmarLlegada(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('vehiculoId', ParseUUIDPipe) vehiculoId: string,
    @Body() dto: LlegadaDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.llegada.firmar(id, vehiculoId, dto, actor);
  }
}
