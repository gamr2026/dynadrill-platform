import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Permission } from '@dyn/authz';
import { AuthUser, CurrentUser, RequirePermission } from '@dyn/common';
import { ClasificacionDesecho } from '../generated/client';
import { DesechosConsultaService } from './desechos-consulta.service';
import { DesechosService } from './desechos.service';

const P = Permission;

export class ListarDesechosDto {
  @IsOptional() @IsString() @MaxLength(30) estado?: string;
  @IsOptional() @IsString() @MaxLength(100) q?: string;
}

export class LineaDesechoDto {
  @IsString() @MaxLength(500) descripcion!: string;
  @IsOptional() @IsString() @MaxLength(100) numeroLote?: string;
  @IsString() @MaxLength(100) codigo!: string;
  @IsNumber({ maxDecimalPlaces: 3 }) @Min(0.001) cantidadGalones!: number;
  @IsOptional() @IsInt() @Min(0) bultos?: number;
}

export class RegistrarDesechoDto {
  @IsIn(Object.values(ClasificacionDesecho)) clasificacion!: ClasificacionDesecho;
  @IsUUID() contenedorId!: string;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsUUID('all', { each: true })
  caracteristicaIds?: string[];
  @IsString() @MaxLength(2000) descripcion!: string;
  @IsOptional() @IsUUID() pozoId?: string;
  @IsOptional() @IsString() @MaxLength(300) ubicacion?: string;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => LineaDesechoDto)
  items!: LineaDesechoDto[];
}

/**
 * Desechos. Ruta pública `/api/v2/qhse/desechos`. Registrar es de cualquier usuario autenticado (`qhse.eventos.reportar`);
 * verlos y gestionarlos es del equipo HSE.
 */
@Controller('qhse/desechos')
export class DesechosController {
  constructor(
    private readonly desechos: DesechosService,
    private readonly consulta: DesechosConsultaService,
  ) {}

  /** Catálogos del formulario de registro (lo usa quien reporta, aunque no vea la bandeja). */
  @RequirePermission(P.QHSE_REPORTAR)
  @Get('catalogos')
  catalogos() {
    return this.consulta.catalogos();
  }

  @RequirePermission(P.QHSE_REPORTAR)
  @Post()
  registrar(@Body() dto: RegistrarDesechoDto, @CurrentUser() actor: AuthUser) {
    return this.desechos.registrar(dto, actor);
  }

  @RequirePermission(P.DESECHOS_VER)
  @Get()
  listar(@Query() q: ListarDesechosDto) {
    return this.consulta.listar(q);
  }

  @RequirePermission(P.DESECHOS_VER)
  @Get(':id')
  detalle(@Param('id', ParseUUIDPipe) id: string) {
    return this.consulta.detalle(id);
  }
}
