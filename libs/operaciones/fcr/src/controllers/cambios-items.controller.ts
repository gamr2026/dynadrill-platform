import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
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
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Permission } from '@dyn/authz';
import { AuthUser, CurrentUser, RequirePermission } from '@dyn/common';
import { CambiosItemsService } from '../services/cambios-items.service';

const P = Permission;
const TIPOS_LINEA = ['servicio', 'material', 'herramienta', 'movilizacion'] as const;

export class ItemCambioDto {
  /** Ítem de la lista de precios del cliente (en Comercial). */
  @IsUUID() listaPreciosItemId!: string;
  @IsString() @MaxLength(100) codigo!: string;
  @IsString() @MaxLength(500) descripcion!: string;
  /** Unidad del catálogo compartido (`catalogos.unidad_medida`), la del ítem de la lista. */
  @IsUUID() unidadMedidaId!: string;
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0.001)
  @Max(999999999)
  cantidad!: number;
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  descuentoPct?: number;
  @IsIn(TIPOS_LINEA) tipoLinea!: (typeof TIPOS_LINEA)[number];
}

export class ProponerCambioDto {
  @IsString() @MinLength(3) @MaxLength(1000) motivo!: string;
  /** La lista COMPLETA de ítems que debe quedar en el pedido. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => ItemCambioDto)
  items!: ItemCambioDto[];
}

export class RechazarCambioDto {
  @IsOptional() @IsString() @MaxLength(1000) motivo?: string;
}

/** Cambio de ítems del pedido: lo propone el Operador del equipo y lo aprueba o rechaza el Supervisor del ticket. */
@Controller('operaciones/fcr')
export class CambiosItemsController {
  constructor(private readonly cambios: CambiosItemsService) {}

  @RequirePermission(P.FCR_CAMBIOS_SOLICITAR)
  @Post('tickets/:id/cambios-items')
  proponer(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ProponerCambioDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.cambios.proponer(id, dto.motivo, dto.items, actor);
  }

  @RequirePermission(P.FCR_CAMBIOS_SOLICITAR, P.FCR_CAMBIOS_APROBAR)
  @Get('tickets/:id/cambios-items')
  listar(@Param('id', ParseUUIDPipe) id: string) {
    return this.cambios.listar(id);
  }

  /** Bandeja de Aprobaciones del Supervisor. */
  @RequirePermission(P.FCR_CAMBIOS_APROBAR)
  @Get('cambios-items/pendientes')
  pendientes(@CurrentUser() actor: AuthUser) {
    return this.cambios.pendientes(actor);
  }

  @RequirePermission(P.FCR_CAMBIOS_APROBAR)
  @Post('cambios-items/:id/aprobar')
  aprobar(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthUser) {
    return this.cambios.aprobar(id, actor);
  }

  @RequirePermission(P.FCR_CAMBIOS_APROBAR)
  @Post('cambios-items/:id/rechazar')
  rechazar(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RechazarCambioDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.cambios.rechazar(id, dto.motivo ?? null, actor);
  }
}
