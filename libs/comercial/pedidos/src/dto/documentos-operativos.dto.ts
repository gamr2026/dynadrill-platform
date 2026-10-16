import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
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
  ValidateNested,
} from 'class-validator';

export const TIPOS_DOCUMENTO_OPERATIVO = ['reporte_job', 'reporte_herramientas'] as const;
export const ORIGENES_OPERATIVOS = ['fcr', 'pumping'] as const;
export const ESTADOS_USO_HERRAMIENTA = ['operacion', 'stand_by', 'daily_charge', 'venta'] as const;

const HORA = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

/** Tabla dentro de una actividad: encabezados y filas (cada fila con una celda por encabezado). */
export class TablaOperativaDto {
  @IsOptional() @IsString() @MaxLength(200) titulo?: string;
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  columnas!: string[];
  @IsArray()
  @ArrayMaxSize(500)
  @IsArray({ each: true })
  filas!: string[][];
}

export class ActividadOperativaDto {
  @IsDateString() fecha!: string;
  @Matches(HORA, { message: 'La hora de inicio debe ser HH:mm' }) horaInicio!: string;
  @Matches(HORA, { message: 'La hora de fin debe ser HH:mm' }) horaFin!: string;
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(24) duracionHoras!: number;
  @IsString() @MaxLength(4000) detalle!: string;
  @IsOptional() @IsString() @MaxLength(200) autor?: string;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => TablaOperativaDto)
  tablas?: TablaOperativaDto[];
}

/** Corrección de Facturación de un día del Reporte Job. Una lista vacía de actividades quita el día. */
export class CorregirDiaOperativoDto {
  @IsIn(ORIGENES_OPERATIVOS) origen!: (typeof ORIGENES_OPERATIVOS)[number];
  @IsDateString() fecha!: string;
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => ActividadOperativaDto)
  actividades!: ActividadOperativaDto[];
}

export class UsoHerramientaDto {
  @IsDateString() fecha!: string;
  @IsIn(ESTADOS_USO_HERRAMIENTA) estado!: (typeof ESTADOS_USO_HERRAMIENTA)[number];
}

export class HerramientaOperativaDto {
  @IsString() @MaxLength(300) nombre!: string;
  @IsOptional() @IsString() @MaxLength(100) serie?: string;
  /** Código de la herramienta en la lista de precios del cliente (con él se factura). */
  @IsOptional() @IsString() @MaxLength(100) codigo?: string;
  @IsArray()
  @ArrayMaxSize(400)
  @ValidateNested({ each: true })
  @Type(() => UsoHerramientaDto)
  usos!: UsoHerramientaDto[];
}

/** Un documento operativo que llega de Operaciones. Enviar otro con la misma clave (tipo, origen, fecha) lo reemplaza. */
export class RecibirDocumentoOperativoDto {
  @IsIn(TIPOS_DOCUMENTO_OPERATIVO) tipo!: (typeof TIPOS_DOCUMENTO_OPERATIVO)[number];
  @IsIn(ORIGENES_OPERATIVOS) origen!: (typeof ORIGENES_OPERATIVOS)[number];
  /** Referencia al ticket en Operaciones. */
  @IsOptional() @IsString() @MaxLength(100) ticketRef?: string;
  /** Día del reporte: obligatorio en el Reporte Job y prohibido en el de herramientas. */
  @IsOptional() @IsDateString() fecha?: string;
  @IsOptional() @IsString() @MaxLength(200) firmadoPor?: string;
  @IsOptional() @IsDateString() firmadoAt?: string;
  @IsOptional() @IsUUID() supervisorId?: string;
  @IsOptional() @IsUUID() operadorId?: string;

  /** Solo en el Reporte Job. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => ActividadOperativaDto)
  actividades?: ActividadOperativaDto[];

  /** Solo en el Reporte de Herramientas. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(300)
  @ValidateNested({ each: true })
  @Type(() => HerramientaOperativaDto)
  herramientas?: HerramientaOperativaDto[];
}

export class DocumentosOperativosQueryDto {
  @IsOptional() @IsIn(TIPOS_DOCUMENTO_OPERATIVO) tipo?: (typeof TIPOS_DOCUMENTO_OPERATIVO)[number];
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) limit?: number;
}
