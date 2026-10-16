import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export const ORIGENES_ITEM_GUIA = ['herramienta', 'material', 'manual'] as const;
const HORA = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

export class GuiaItemDto {
  @IsOptional() @IsString() @MaxLength(60) codigo?: string;
  @IsString() @MinLength(1) @MaxLength(300) descripcion!: string;
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 3 }) @IsPositive() cantidad!: number;
  @IsString() @MinLength(1) @MaxLength(30) unidad!: string;
  @IsOptional() @IsString() @MaxLength(80) serie?: string;
  @IsIn(ORIGENES_ITEM_GUIA) origen!: (typeof ORIGENES_ITEM_GUIA)[number];
}

export class EmitirGuiaDto {
  @IsDateString() fecha!: string;
  @IsUUID() lugarOrigenId!: string;
  @IsOptional() @IsString() @MaxLength(200) solicitadoPorNombre?: string;
  @IsOptional() @IsString() @MaxLength(200) despachadoPorNombre?: string;
  @IsOptional() @Matches(HORA, { message: 'La hora de salida debe ser HH:mm' }) horaSalida?: string;
  @IsOptional()
  @Matches(HORA, { message: 'La hora de llegada debe ser HH:mm' })
  horaLlegada?: string;
  @IsUUID() transportistaId!: string;
  @IsOptional() @IsUUID() vehiculoId?: string;
  @IsOptional() @IsUUID() choferId?: string;
  @IsOptional() @IsString() @MaxLength(1000) observaciones?: string;
  /** Si se indica, la guía lleva ese número en lugar del siguiente del secuencial (no puede estar usado). */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) numero?: number;
  /** Guía anulada de este pedido a la que reemplaza. */
  @IsOptional() @IsUUID() reemplazaAId?: string;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(300)
  @ValidateNested({ each: true })
  @Type(() => GuiaItemDto)
  items!: GuiaItemDto[];
}

export class ReasignarNumeroGuiaDto {
  @Type(() => Number) @IsInt() @Min(1) numero!: number;
  @IsString() @MinLength(3) @MaxLength(500) motivo!: string;
}

export class AnularGuiaDto {
  @IsString() @MinLength(3) @MaxLength(500) motivo!: string;
}

export class RegistrarGuiaFirmadaDto {
  /** Archivo subido a `archivos` con módulo `guia_documento`. */
  @IsUUID() archivoId!: string;
}

export class CrearLugarDespachoDto {
  @IsString() @MinLength(2) @MaxLength(120) nombre!: string;
}
