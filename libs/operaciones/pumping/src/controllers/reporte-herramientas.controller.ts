import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { IsIn, IsNumber, Max, Min, ValidateIf } from 'class-validator';
import { Permission } from '@dyn/authz';
import { AuthUser, CurrentUser, RequirePermission } from '@dyn/common';
import type { EstadoItemReporte } from '../generated/client';
import { ReporteHerramientasService } from '../services/reporte-herramientas.service';

const P = Permission;
const ESTADOS: EstadoItemReporte[] = ['operacion', 'daily_charge', 'venta'];

export class MarcarDiaDto {
  @IsIn(ESTADOS) estado!: EstadoItemReporte;
  /** Obligatoria en las líneas que no son por día; en las de por día la marca vale 1. */
  @ValidateIf((o: MarcarDiaDto) => o.cantidad !== undefined)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0.001)
  @Max(1_000_000)
  cantidad?: number;
}

/** Reporte de Herramientas de un ticket de Pumping: las líneas cotizadas del pedido repartidas por día. */
@Controller('operaciones/pumping/tickets/:id/reporte-herramientas')
export class ReporteHerramientasController {
  constructor(private readonly reporte: ReporteHerramientasService) {}

  /** El reporte; la primera vez que se pide en la Ejecución operativa se precarga desde lo cotizado. */
  @RequirePermission(P.PUMPING_OPERAR)
  @Get()
  obtener(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthUser) {
    return this.reporte.obtener(id, actor.id);
  }

  /** Marca un día de una línea (operación, daily charge o venta). */
  @RequirePermission(P.PUMPING_OPERAR)
  @Put('lineas/:lineaId/dias/:fecha')
  marcarDia(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('lineaId', ParseUUIDPipe) lineaId: string,
    @Param('fecha') fecha: string,
    @Body() dto: MarcarDiaDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.reporte.marcarDia(id, lineaId, fecha, dto.estado, dto.cantidad, actor);
  }

  @RequirePermission(P.PUMPING_OPERAR)
  @Delete('lineas/:lineaId/dias/:fecha')
  desmarcarDia(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('lineaId', ParseUUIDPipe) lineaId: string,
    @Param('fecha') fecha: string,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.reporte.marcarDia(id, lineaId, fecha, null, undefined, actor);
  }

  /** «El reporte está completo»: se envía a Comercial como documento operativo. */
  @RequirePermission(P.PUMPING_OPERAR)
  @Post('completar')
  completar(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthUser) {
    return this.reporte.completar(id, actor);
  }
}
