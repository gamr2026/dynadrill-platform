import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Permission } from '@dyn/authz';
import { AuthUser, CurrentUser, RequirePermission } from '@dyn/common';
import type { CausaFaltante } from '../generated/client';
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

/** Control de retorno de las herramientas (Bodega). */
@Controller('operaciones/fcr')
export class RetornoController {
  constructor(private readonly retorno: RetornoService) {}

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
}
