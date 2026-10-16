import { PartialType } from '@nestjs/mapped-types';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
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

export const TIPOS_IDENTIFICACION = ['ruc', 'cedula', 'pasaporte'] as const;

/** Placa en mayúsculas y sin espacios ni guiones: `GSI-6538` → `GSI6538`. */
const placa = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.toUpperCase().replace(/[\s-]/g, '') : value;

export class CreateTransportistaDto {
  @IsString() @MinLength(1) @MaxLength(200) nombreFiscal!: string;
  @IsIn(TIPOS_IDENTIFICACION) tipoIdentificacion!: (typeof TIPOS_IDENTIFICACION)[number];
  @IsString() @MinLength(3) @MaxLength(30) identificacion!: string;
  /** Código en AS2 (p. ej. `GRAL`), si lo tiene. */
  @IsOptional() @IsString() @MaxLength(30) codigo?: string;
  @IsOptional() @IsBoolean() habilitado?: boolean;
}
export class UpdateTransportistaDto extends PartialType(CreateTransportistaDto) {}

export class CreateTipoVehiculoDto {
  @IsString() @MinLength(1) @MaxLength(80) nombre!: string;
  @IsOptional() @IsBoolean() habilitado?: boolean;
}
export class UpdateTipoVehiculoDto extends PartialType(CreateTipoVehiculoDto) {}

export class CreateVehiculoDto {
  @Transform(placa)
  @Matches(/^[A-Z0-9]{5,8}$/, { message: 'La placa debe tener entre 5 y 8 letras o números' })
  placa!: string;
  @IsOptional() @IsString() @MaxLength(80) marca?: string;
  @IsOptional() @IsString() @MaxLength(80) modelo?: string;
  @IsOptional() @IsInt() @Min(1950) @Max(2100) anio?: number;
  @IsOptional() @IsUUID() tipoVehiculoId?: string | null;
  /// A quién pertenece el vehículo.
  @IsOptional() @IsUUID() transportistaId?: string | null;
  @IsOptional() @IsBoolean() habilitado?: boolean;
}
export class UpdateVehiculoDto extends PartialType(CreateVehiculoDto) {}

export class CreateChoferDto {
  @IsUUID() transportistaId!: string;
  @IsString() @MinLength(3) @MaxLength(30) licencia!: string;
  @IsString() @MinLength(2) @MaxLength(200) nombre!: string;
  @IsOptional() @IsBoolean() habilitado?: boolean;
}
export class UpdateChoferDto extends PartialType(CreateChoferDto) {}

export class TransporteQueryDto {
  @IsOptional() @IsUUID() transportistaId?: string;
}
