import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import type { MetodoHttp, TransformacionCampo } from '../generated/client';
import { TRANSFORMACIONES } from '../engine/mapeo';

export class ActualizarProveedorDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  nombre?: string;

  @IsOptional()
  @IsUrl({ require_tld: false, protocols: ['http', 'https'] })
  @MaxLength(300)
  baseUrl?: string;

  @IsOptional()
  @IsIn(['produccion', 'pruebas'])
  ambiente?: 'produccion' | 'pruebas';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1000)
  @Max(300000)
  timeoutMs?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(5)
  reintentos?: number;

  /** Valores NO secretos que las plantillas leen como `{{var.x}}`. */
  @IsOptional()
  @IsObject()
  variables?: Record<string, unknown>;

  @IsOptional()
  @IsBoolean()
  activo?: boolean;
}

export class MapeoDto {
  @IsString()
  @Matches(/^[A-Za-z][A-Za-z0-9_]*$/)
  destino!: string;

  @IsString()
  @MaxLength(200)
  origen!: string;

  @IsOptional()
  @IsIn(TRANSFORMACIONES as unknown as string[])
  transformacion?: TransformacionCampo;

  @IsOptional()
  @IsBoolean()
  obligatorio?: boolean;
}

export class PaginacionDto {
  @IsIn(['offset'])
  tipo!: 'offset';

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5000)
  tamano!: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  inicio?: number;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  campoDesde?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  campoTamano?: string;
}

/** Una versión nueva de una operación (queda inactiva hasta activarla). */
export class CrearVersionDto {
  @IsOptional()
  @IsString()
  @MaxLength(300)
  descripcion?: string;

  @IsIn(['GET', 'POST', 'PUT', 'PATCH'])
  metodo!: MetodoHttp;

  @IsString()
  @MaxLength(300)
  ruta!: string;

  @IsOptional()
  @IsObject()
  cabeceras?: Record<string, string>;

  @IsOptional()
  cuerpo?: unknown;

  @IsOptional()
  @ValidateNested()
  @Type(() => PaginacionDto)
  paginacion?: PaginacionDto;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  rutaResultados?: string;

  @IsOptional()
  @IsBoolean()
  requiereAuth?: boolean;

  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => MapeoDto)
  mapeos!: MapeoDto[];
}

export class ProbarDto {
  @IsOptional()
  @IsObject()
  param?: Record<string, unknown>;
}

export class EjecucionesQueryDto {
  @IsOptional()
  @IsString()
  @Matches(/^[a-z][a-z0-9_]*$/)
  proveedor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}
