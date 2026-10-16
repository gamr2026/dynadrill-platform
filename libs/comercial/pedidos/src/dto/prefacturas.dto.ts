import { Type } from 'class-transformer';
import {
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export const MEDIOS_ENVIO = ['email', 'portal'] as const;
export const TIPOS_FIRMANTE = ['company_man', 'cliente', 'dynadrill'] as const;
export const AREAS_DEVOLUCION = ['ventas', 'operaciones', 'facturacion'] as const;

export class RegistrarTicketDto {
  /** Número que AS2 asignó a la prefactura (PRC-), sin el prefijo. Es el número de ticket de Dynadrill. */
  @Type(() => Number) @IsInt() @Min(1) numero!: number;
}

export class EnviarPrefacturaDto {
  @IsIn(MEDIOS_ENVIO) medio!: (typeof MEDIOS_ENVIO)[number];
}

export class AgregarFirmaDto {
  @IsIn(TIPOS_FIRMANTE) firmanteTipo!: (typeof TIPOS_FIRMANTE)[number];
  /** Persona del catálogo (representante de campo o de Quito), si el firmante es una de ellas. */
  @IsOptional() @IsUUID() personaId?: string;
  /** Obligatorio si no se indica `personaId`. */
  @IsOptional() @IsString() @MinLength(2) @MaxLength(200) nombre?: string;
  @IsOptional() @IsString() @MaxLength(200) cargo?: string;
  @IsDateString() firmadoAt!: string;
  /** Archivo subido a `archivos` con módulo `prefactura_documento`. */
  @IsUUID() archivoId!: string;
}

export class FirmarPrefacturaDto {
  /** Por qué se tardó en firmar, si aplica. */
  @IsOptional() @IsString() @MaxLength(500) razonRetraso?: string;
}

export class RechazarPrefacturaDto {
  @IsString() @MinLength(5) @MaxLength(1000) motivo!: string;
  @IsIn(AREAS_DEVOLUCION) devueltoA!: (typeof AREAS_DEVOLUCION)[number];
}
