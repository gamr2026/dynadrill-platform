import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class EmpleadosAs2QueryDto {
  @IsOptional()
  @IsIn(['true', 'false'])
  activo?: 'true' | 'false';

  /** Busca en nombres, apellidos, cargo y cédula. */
  @IsOptional()
  @IsString()
  @MaxLength(80)
  q?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}

export class CrearCuentasDto {
  /** Por defecto `true`: solo muestra lo que haría. Enviar `false` para crear las cuentas. */
  @IsOptional()
  @IsBoolean()
  simular?: boolean;

  /** Limita a estas cédulas (para crear de a pocos). Sin esto, procesa a todos los empleados activos. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  cedulas?: string[];
}
