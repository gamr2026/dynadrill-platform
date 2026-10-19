import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Put,
  Query,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
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
import { ConfiguracionCodigosService } from '../services/configuracion-codigos.service';

const P = Permission;

export class ListarConfiguracionDto {
  @IsUUID() clienteId!: string;
}

export class KitItemDto {
  @IsUUID() articuloId!: string;
  @IsInt() @Min(1) @Max(999) cantidad!: number;
}

export class GuardarConfiguracionDto {
  @IsUUID() clienteId!: string;
  @IsString() @MinLength(1) @MaxLength(60) codigo!: string;
  @IsIn(['herramienta', 'servicio']) clasificacion!: 'herramienta' | 'servicio';
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => KitItemDto)
  kit!: KitItemDto[];
}

/** Qué hace FCR con cada código de la lista de precios de un cliente (herramienta con su kit, o servicio). */
@Controller('operaciones/fcr/configuracion-codigos')
export class ConfiguracionCodigosController {
  constructor(private readonly configuracion: ConfiguracionCodigosService) {}

  /** Las configuraciones de un cliente. La lista de precios (códigos y descripciones) la trae la pantalla de Comercial. */
  @RequirePermission(P.FCR_VER)
  @Get()
  listar(@Query() q: ListarConfiguracionDto) {
    return this.configuracion.listar(q.clienteId);
  }

  /** Crea o reemplaza la configuración de un código (el kit se reemplaza completo). */
  @RequirePermission(P.FCR_CONFIGURACION_GESTIONAR)
  @Put()
  guardar(@Body() dto: GuardarConfiguracionDto, @CurrentUser() actor: AuthUser) {
    return this.configuracion.guardar(dto, actor);
  }

  @RequirePermission(P.FCR_CONFIGURACION_GESTIONAR)
  @Delete(':id')
  @HttpCode(204)
  async eliminar(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.configuracion.eliminar(id);
  }
}
