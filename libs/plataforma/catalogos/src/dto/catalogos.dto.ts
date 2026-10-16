import { PartialType } from '@nestjs/mapped-types';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/** Tipos de persona de contacto (`CHECK` en la base: `persona_contacto_tipo_check`). */
export const TIPOS_PERSONA = [
  'representante_campo',
  'representante_quito',
  'analista_facturacion',
  'agente_comercial',
] as const;
export type TipoPersona = (typeof TIPOS_PERSONA)[number];

const texto = (max = 200) => [IsString(), MinLength(1), MaxLength(max)];
void texto;

// ---------------------------------------------------------------- Bloques
export class CreateBloqueDto {
  @IsString() @MinLength(1) @MaxLength(120) nombre!: string;
  @IsOptional() @IsBoolean() habilitado?: boolean;
}
export class UpdateBloqueDto extends PartialType(CreateBloqueDto) {}

// ---------------------------------------------------------------- Campos
export class CreateCampoDto {
  @IsString() @MinLength(1) @MaxLength(120) nombre!: string;
  /** Zona comercial: id del catálogo `zona`. */
  @IsOptional() @IsUUID() zonaId?: string | null;
  @IsOptional() @IsBoolean() habilitado?: boolean;
}
export class UpdateCampoDto extends PartialType(CreateCampoDto) {}

// ------------------------------------------------------------------ Zonas
export class CreateCatalogoSimpleDto {
  @IsString() @MinLength(1) @MaxLength(80) nombre!: string;
  @IsOptional() @IsBoolean() habilitado?: boolean;
}
export class UpdateCatalogoSimpleDto extends PartialType(CreateCatalogoSimpleDto) {}

// ----------------------------------------- Bodegas y condiciones de pago
export class CreateCatalogoAs2Dto {
  @IsString() @MinLength(1) @MaxLength(120) nombre!: string;
  /** Id del mismo registro en AS2 (para enlazar los pedidos que vienen de allá). */
  @IsOptional() @IsInt() @Min(1) as2Id?: number;
  @IsOptional() @IsBoolean() habilitado?: boolean;
}
export class UpdateCatalogoAs2Dto extends PartialType(CreateCatalogoAs2Dto) {}

export interface CatalogoAs2Response {
  id: string;
  as2Id: number | null;
  nombre: string;
  habilitado: boolean;
}

// -------------------------------------------------------------- Taladros
export class CreateTaladroDto {
  @IsString() @MinLength(1) @MaxLength(120) nombre!: string;
  @IsOptional() @IsString() @MaxLength(120) rigContractual?: string;
  @IsOptional() @IsBoolean() habilitado?: boolean;
}
export class UpdateTaladroDto extends PartialType(CreateTaladroDto) {}

// ----------------------------------------------------------------- Pozos
export class CreatePozoDto {
  @IsString() @MinLength(1) @MaxLength(60) codigo!: string;
  @IsString() @MinLength(1) @MaxLength(200) nombreCompleto!: string;
  @IsUUID() campoId!: string;
  @IsUUID() bloqueId!: string;
  @IsOptional() @IsBoolean() habilitado?: boolean;
}
export class UpdatePozoDto extends PartialType(CreatePozoDto) {}

export class PozosQueryDto {
  @IsOptional() @IsUUID() campoId?: string;
  @IsOptional() @IsUUID() bloqueId?: string;
}

// -------------------------------------------------------------- Clientes
export class CreateClienteDto {
  @IsString() @MinLength(1) @MaxLength(40) tipoIdentificacion!: string;
  @IsString() @MinLength(1) @MaxLength(40) identificacion!: string;
  @IsString() @MinLength(1) @MaxLength(200) nombreComercial!: string;
  @IsOptional() @IsString() @MaxLength(200) nombreFiscal?: string;
  @IsOptional() @IsBoolean() activo?: boolean;
}
export class UpdateClienteDto extends PartialType(CreateClienteDto) {}

// -------------------------------------------------------------- Personas
export class CreatePersonaDto {
  @IsIn(TIPOS_PERSONA) tipo!: TipoPersona;
  @IsString() @MinLength(1) @MaxLength(200) nombre!: string;
  /** Solo el Company Man (`representante_campo`) la trae hoy. */
  @IsOptional() @IsString() @MaxLength(40) cedula?: string;
  @IsOptional() @IsBoolean() activo?: boolean;
}
export class UpdatePersonaDto extends PartialType(CreatePersonaDto) {}

export class PersonasQueryDto {
  @IsOptional() @IsIn(TIPOS_PERSONA) tipo?: TipoPersona;
}

// ------------------------------------------------------------ Respuestas
export interface BloqueResponse {
  id: string;
  /** TRANSICIÓN: id numérico en el backend demo (null si nació en el backend nuevo). */
  legacyId: number | null;
  nombre: string;
  habilitado: boolean;
}

export interface CampoResponse {
  id: string;
  legacyId: number | null;
  nombre: string;
  /** Zona comercial: su nombre y su id en el catálogo. */
  zona: string | null;
  zonaId: string | null;
  habilitado: boolean;
}

/** Zona: catálogo sencillo (nombre + habilitado). */
export interface CatalogoSimpleResponse {
  id: string;
  nombre: string;
  habilitado: boolean;
}

export interface TaladroResponse {
  id: string;
  legacyId: number | null;
  nombre: string;
  rigContractual: string | null;
  habilitado: boolean;
}

export interface PozoResponse {
  id: string;
  legacyId: number | null;
  codigo: string;
  nombreCompleto: string;
  campoId: string;
  bloqueId: string;
  habilitado: boolean;
  campo: CampoResponse | null;
  bloque: BloqueResponse | null;
}

export interface ClienteResponse {
  id: string;
  legacyId: number | null;
  tipoIdentificacion: string;
  identificacion: string;
  nombreComercial: string;
  nombreFiscal: string | null;
  activo: boolean;
}

export interface PersonaResponse {
  id: string;
  legacyId: number | null;
  tipo: TipoPersona;
  nombre: string;
  cedula?: string;
  activo: boolean;
}
