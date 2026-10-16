import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
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

export const SOLICITUD_MEDIOS = ['verbal', 'escrita'] as const;

/** Un subtipo elegido, siempre bajo el tipo al que pertenece (ambos salen del catálogo `servicio_tipo`/`servicio_subtipo`). */
export class SubtipoPedidoDto {
  @IsString() @MaxLength(60) tipo!: string;
  @IsString() @MaxLength(120) subtipo!: string;
}

export class ItemPedidoDto {
  /** Siempre un ítem de la lista de precios del cliente. */
  @IsUUID()
  listaPreciosItemId!: string;

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

  /** `plantilla` si vino del Excel de AS2; por defecto `lista`. */
  @IsOptional()
  @IsIn(['lista', 'plantilla'])
  origen?: 'lista' | 'plantilla';
}

class DatosPedidoDto {
  @IsOptional() @IsUUID() clienteId?: string;
  @IsOptional() @IsString() @MaxLength(200) subcliente?: string;

  /** Código de una línea del catálogo `servicio_linea` (se valida contra la base de datos). */
  @IsOptional() @IsString() @MaxLength(30) lineaServicio?: string;
  /** Código de un tipo de OT del catálogo `tipo_ot` (se valida contra la base de datos). */
  @IsOptional() @IsString() @MaxLength(30) tipoOt?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(17)
  @IsString({ each: true })
  @MaxLength(60, { each: true })
  tiposServicio?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(60)
  @ValidateNested({ each: true })
  @Type(() => SubtipoPedidoDto)
  subtiposServicio?: SubtipoPedidoDto[];

  @IsOptional() @IsUUID() campoId?: string;
  @IsOptional() @IsUUID() bloqueId?: string;
  @IsOptional() @IsUUID() pozoId?: string;
  @IsOptional() @IsUUID() taladroId?: string;
  /** Trabajo sin taladro. Excluye a `taladroId`. */
  @IsOptional() @IsBoolean() rigless?: boolean;

  @IsOptional() @IsString() @MinLength(1) @MaxLength(120) numeroContrato?: string;
  @IsOptional() @IsDateString() fechaInicioServicio?: string;
  @IsOptional() @IsDateString() fechaFinServicio?: string;

  /** Por defecto, quien crea el pedido. */
  @IsOptional() @IsUUID() agenteComercialId?: string;
  @IsOptional() @IsUUID() tecnicoHseId?: string;
  @IsOptional() @IsUUID() representanteCampoId?: string;
  @IsOptional() @IsUUID() representanteQuitoId?: string;

  /** Id de la condición de pago en el catálogo `catalogos.condicion_pago`. */
  @IsOptional() @IsUUID() condicionPagoId?: string | null;
  /** Id de la bodega en el catálogo `catalogos.bodega`. */
  @IsOptional() @IsUUID() bodegaId?: string | null;
  @IsOptional() @IsIn(SOLICITUD_MEDIOS) solicitudMedio?: (typeof SOLICITUD_MEDIOS)[number];

  /** Si viene, REEMPLAZA todos los ítems del pedido. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(300)
  @ValidateNested({ each: true })
  @Type(() => ItemPedidoDto)
  items?: ItemPedidoDto[];
}

export class CrearPedidoDto extends DatosPedidoDto {
  /** `true`: validar todo, emitir el código y abrir el pedido. Por defecto queda en borrador ("por completar"). */
  @IsOptional() @IsBoolean() abrir?: boolean;
}

export class ActualizarPedidoDto extends DatosPedidoDto {
  /** La versión que vio quien edita; si otra persona editó antes, responde 409. */
  @IsInt()
  @Min(1)
  version!: number;
}

export class MotivoDto {
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  motivo!: string;
}

export class TransicionDto {
  @IsString()
  @MaxLength(60)
  estado!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  motivo?: string;

  /** `true` solo para Superadmin: salta el flujo y exige motivo. */
  @IsOptional()
  @IsBoolean()
  forzar?: boolean;
}

export class AsignarAnalistaDto {
  @IsUUID()
  analistaId!: string;
}

export class DesdeAs2Dto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  as2IdPedidoCliente!: number;
}

export class VincularAs2Dto extends DesdeAs2Dto {}

export class FilaPlantillaDto {
  @IsString() @MinLength(1) @MaxLength(60) codigo!: string;

  @Type(() => Number)
  @IsNumber()
  @Min(0.001)
  cantidad!: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  precio?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  descuentoPct?: number;
}

export class ValidarPlantillaDto {
  @IsUUID() clienteId!: string;

  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => FilaPlantillaDto)
  filas!: FilaPlantillaDto[];
}

export class PedidosQueryDto {
  @IsOptional() @IsString() @MaxLength(60) estado?: string;
  /** Varios estados separados por coma. */
  @IsOptional() @IsString() @MaxLength(400) estados?: string;
  @IsOptional() @IsString() @MaxLength(30) linea?: string;
  @IsOptional() @IsIn(['portal', 'as2']) origen?: 'portal' | 'as2';
  @IsOptional() @IsUUID() clienteId?: string;
  @IsOptional() @IsString() @MaxLength(100) q?: string;
  /** Pedidos terminados sin analista de facturación (bandeja de la jefa de Facturación). */
  @IsOptional() @IsIn(['true', 'false']) sinAnalista?: 'true' | 'false';
  @IsOptional()
  @IsIn(['no_aplica', 'pendiente_de_crear_en_as2', 'vinculado', 'error'])
  as2Sync?: 'no_aplica' | 'pendiente_de_crear_en_as2' | 'vinculado' | 'error';

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}

export class VinculosAs2QueryDto {
  /** Ids de AS2 separados por coma (máximo 100). */
  @IsString() @MaxLength(1200) ids!: string;
}

export class ListasPreciosQueryDto {
  @IsOptional() @IsUUID() clienteId?: string;
  @IsOptional() @IsIn(['true', 'false']) activa?: 'true' | 'false';
}

export class ItemsListaQueryDto {
  /** Solo en `GET /listas-precios/items` (los ítems elegibles de un cliente). */
  @IsOptional() @IsUUID() clienteId?: string;
  @IsOptional() @IsString() @MaxLength(100) q?: string;
  @IsOptional() @IsIn(['Material', 'Servicio']) tipo?: 'Material' | 'Servicio';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
}

export class AdjuntarDocumentoDto {
  /** Id del archivo en el módulo `archivos` (subido con módulo `pedido_documento`). */
  @IsUUID() archivoId!: string;
}
