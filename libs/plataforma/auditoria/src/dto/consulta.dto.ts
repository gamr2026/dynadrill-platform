import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsISO8601, IsOptional, IsUUID, Matches, Max, Min } from 'class-validator';
import { OrigenEvento } from '../generated/client';

const CODIGO = /^[a-z][a-z0-9_.]*$/;

/** Filtros y paginación comunes a la búsqueda y a la línea de tiempo. */
export class ConsultaBaseDto {
  @IsOptional()
  @IsISO8601({}, { message: 'desde debe ser una fecha u hora ISO 8601' })
  desde?: string;

  @IsOptional()
  @IsISO8601({}, { message: 'hasta debe ser una fecha u hora ISO 8601' })
  hasta?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limite?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pagina?: number;
}

/** Línea de tiempo de una entidad: el tipo y el id del sujeto son obligatorios. */
export class LineaDeTiempoQueryDto extends ConsultaBaseDto {
  @Matches(CODIGO, { message: 'sujetoTipo no tiene un formato válido' })
  sujetoTipo!: string;

  @IsUUID(undefined, { message: 'sujetoId debe ser un UUID' })
  sujetoId!: string;
}

/** Búsqueda libre en el registro: todos los filtros son opcionales y se combinan con «y». */
export class BuscarEventosQueryDto extends ConsultaBaseDto {
  @IsOptional()
  @IsUUID(undefined, { message: 'actorId debe ser un UUID' })
  actorId?: string;

  /** Código exacto del tipo de evento (`operaciones.pumping.ticket_creado`). */
  @IsOptional()
  @Matches(CODIGO, { message: 'tipo no tiene un formato válido' })
  tipo?: string;

  @IsOptional()
  @IsEnum(OrigenEvento, { message: 'origen no es un contenedor conocido' })
  origen?: OrigenEvento;

  @IsOptional()
  @Matches(CODIGO, { message: 'sujetoTipo no tiene un formato válido' })
  sujetoTipo?: string;

  @IsOptional()
  @IsUUID(undefined, { message: 'sujetoId debe ser un UUID' })
  sujetoId?: string;

  /** Código de una clave de la lista blanca (`pedido_codigo`); va junto con `valor`. */
  @IsOptional()
  @Matches(/^[a-z][a-z0-9_]*$/, { message: 'clave no tiene un formato válido' })
  clave?: string;

  @IsOptional()
  @Matches(/^.{1,200}$/, { message: 'valor debe tener entre 1 y 200 caracteres' })
  valor?: string;
}

export interface EventoAuditadoResponse {
  id: string;
  tipo: string;
  version: number;
  ocurridoAt: string;
  origen: OrigenEvento;
  sujeto: { tipo: string; id: string };
  actor: { id: string; nombre: string; rol: { codigo: string; nombre: string } | null } | null;
  correlacionId: string | null;
  causaId: string | null;
  /** Claves de negocio del evento: `{ pedido_codigo: 'PED-0001' }`. */
  datos: Record<string, string>;
}

/** Lo que se puede elegir al filtrar: lo que ya existe en el registro y las claves de negocio de la lista blanca. */
export interface CatalogosAuditoriaResponse {
  origenes: string[];
  tiposEvento: string[];
  sujetoTipos: string[];
  claves: { codigo: string; descripcion: string }[];
}

export interface PaginaDeEventosResponse {
  total: number;
  pagina: number;
  limite: number;
  items: EventoAuditadoResponse[];
}
