import { OmitType, PartialType } from '@nestjs/mapped-types';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

/** Los parámetros de consulta llegan como texto: `true`/`false` se convierten aquí. */
const aBooleano = ({ value }: { value: unknown }) =>
  value === 'true' ? true : value === 'false' ? false : value;

const TEXTO_CORTO = 200;
const TEXTO_LARGO = 2000;

export class CodigosArticuloDto {
  /** Cadena vacía quita el código. */
  @IsOptional() @IsString() @MaxLength(60) alterno?: string;
  @IsOptional() @IsString() @MaxLength(60) comercial?: string;
  @IsOptional() @IsString() @MaxLength(60) barras?: string;
}

export class CrearArticuloDto {
  /** Código de AS2 del producto. No se puede cambiar después. */
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  @Matches(/^\S+$/, { message: 'El código no puede llevar espacios' })
  codigo!: string;
  @IsString() @MinLength(1) @MaxLength(400) nombre!: string;
  @IsOptional() @IsString() @MaxLength(400) nombreComercial?: string;
  @IsUUID() categoriaId!: string;
  @IsOptional() @IsUUID() subcategoriaId?: string;
  @IsUUID() unidadStockId!: string;
  @IsOptional() @IsString() @MaxLength(TEXTO_LARGO) nota?: string;
  @IsOptional() @IsString() @MaxLength(TEXTO_LARGO) informacionAdicional?: string;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 4 }) @Min(0) costoUnitario?: number;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100) descuentoSugerido?: number;
  @IsOptional() @IsBoolean() activo?: boolean;
  /** Se entrega a una persona (EPI y ropa de trabajo): QHSE lo recibe por evento. */
  @IsOptional() @IsBoolean() entregaPersonal?: boolean;
  /** Tipo de talla que admite al entregarse; `null` quita la talla. Exige `entregaPersonal`. */
  @IsOptional() @IsIn(['ropa', 'calzado', 'guante']) tipoTalla?:
    'ropa' | 'calzado' | 'guante' | null;
  @IsOptional() @ValidateNested() @Type(() => CodigosArticuloDto) codigos?: CodigosArticuloDto;
}

/** Todo opcional; el código no cambia. `subcategoriaId`, `costoUnitario` y `descuentoSugerido` en `null` se quitan. */
export class ActualizarArticuloDto extends PartialType(
  OmitType(CrearArticuloDto, ['codigo'] as const),
) {}

export class ListarArticulosDto {
  @IsOptional() @IsString() @MaxLength(TEXTO_CORTO) q?: string;
  @IsOptional() @IsUUID() categoriaId?: string;
  @IsOptional() @IsUUID() subcategoriaId?: string;
  @IsOptional() @Transform(aBooleano) @IsBoolean() activo?: boolean;
  /** Solo los que tienen existencia. */
  @IsOptional() @Transform(aBooleano) @IsBoolean() conStock?: boolean;
  /** Solo los de categorías de químicos. */
  @IsOptional() @Transform(aBooleano) @IsBoolean() quimicos?: boolean;
  /** Solo los de categorías de repuestos y suministros de mantenimiento. */
  @IsOptional() @Transform(aBooleano) @IsBoolean() repuestos?: boolean;
}

export class ListarMovimientosDto {
  @IsOptional() @IsUUID() bodegaId?: string;
  @IsOptional() @IsDateString() desde?: string;
  @IsOptional() @IsDateString() hasta?: string;
  /** Cuántos renglones (los más recientes). */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1000) limite?: number;
}

export class RegistrarMovimientoDto {
  @IsUUID() articuloId!: string;
  @IsUUID() bodegaId!: string;
  /** El motivo fija el tipo (entrada o salida) y el origen. Solo los motivos manuales. */
  @IsUUID() motivoId!: string;
  @IsNumber({ maxDecimalPlaces: 3 }) @Min(0.001) @Max(99999999999) cantidad!: number;
  @IsOptional() @IsDateString() fecha?: string;
  @IsOptional() @IsString() @MaxLength(500) observacion?: string;
}

export class ConsultarStockDto {
  @IsOptional() @IsUUID() articuloId?: string;
  @IsOptional() @IsUUID() bodegaId?: string;
}

export class ListarMinimosDto {
  @IsOptional() @IsUUID() articuloId?: string;
  @IsOptional() @IsUUID() bodegaId?: string;
  /** `true`: solo los que hoy están por debajo de su mínimo. */
  @IsOptional() @IsIn(['true', 'false']) bajoMinimo?: 'true' | 'false';
}

export class FijarMinimoDto {
  /** Existencia mínima deseada: mayor que cero, hasta 3 decimales. */
  @IsNumber({ maxDecimalPlaces: 3, allowNaN: false, allowInfinity: false })
  @Min(0.001)
  @Max(99_999_999_999)
  minimo!: number;
}

export class ParteDto {
  @IsString() @MinLength(1) @MaxLength(20) item!: string;
  /** Sin código, se omite o va vacío. */
  @IsOptional() @IsString() @MaxLength(60) codigo?: string | null;
  @IsString() @MinLength(1) @MaxLength(TEXTO_CORTO * 2) descripcion!: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(10000) cantidadEsperada?: number;
}

export class CategoriaDto {
  @IsString() @MinLength(1) @MaxLength(TEXTO_CORTO) nombre!: string;
  @IsOptional() @IsBoolean() esQuimica?: boolean;
  @IsOptional() @IsBoolean() llevaPartes?: boolean;
  @IsOptional() @IsBoolean() esRepuesto?: boolean;
}

export class ActualizarCategoriaDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(TEXTO_CORTO) nombre?: string;
  @IsOptional() @IsBoolean() esQuimica?: boolean;
  @IsOptional() @IsBoolean() llevaPartes?: boolean;
  @IsOptional() @IsBoolean() esRepuesto?: boolean;
  @IsOptional() @IsBoolean() activo?: boolean;
}

export class SubcategoriaDto {
  @IsString() @MinLength(1) @MaxLength(TEXTO_CORTO) nombre!: string;
}

export class ActualizarSubcategoriaDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(TEXTO_CORTO) nombre?: string;
  @IsOptional() @IsBoolean() activo?: boolean;
}

export class ListarMotivosDto {
  /** Solo los que la pantalla permite elegir. */
  @IsOptional() @Transform(aBooleano) @IsBoolean() manual?: boolean;
  @IsOptional() @IsIn(['entrada', 'salida']) tipo?: 'entrada' | 'salida';
}

export class ListarDespachosDto {
  @IsOptional()
  @IsIn(['solicitado', 'realizado', 'rechazado'])
  estado?: 'solicitado' | 'realizado' | 'rechazado';
  /** Las solicitudes de un pedido (la ficha del pedido en Comercial). */
  @IsOptional() @IsUUID() pedidoId?: string;
}

/** Bodega despacha: documento de respaldo (obligatorio) y, si hay químicos, la hoja MSDS; ambos subidos antes a `archivos`. */
export class RealizarDespachoDto {
  @IsUUID() archivoRespaldoId!: string;
  @IsOptional() @IsUUID() archivoMsdsId?: string;
  /** Número de la «Orden Salida Material» de AS2. */
  @IsOptional() @IsString() @MaxLength(60) referenciaAs2?: string;
  @IsOptional() @IsString() @MaxLength(1000) notaBodega?: string;
}

/** Bodega rechaza la solicitud (p. ej. sin stock): con motivo. */
export class RechazarDespachoDto {
  @IsString() @MinLength(3) @MaxLength(1000) motivo!: string;
  @IsOptional() @IsString() @MaxLength(1000) notaBodega?: string;
}

/** Salida de stock que respalda un despacho a bodega. */
export class SalidaDespachoDto {
  @IsUUID() articuloId!: string;
  @IsUUID() bodegaId!: string;
  @IsNumber({ maxDecimalPlaces: 3 }) @Min(0.001) @Max(99999999999) cantidad!: number;
  @IsOptional() @IsString() @MaxLength(500) observacion?: string;
}
