import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';

/** Código de permiso: `<modulo>.<recurso>.<accion>`. */
const CODIGO_RE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

export class ReemplazarPermisosDto {
  /** El conjunto COMPLETO de permisos del rol (lo que no esté aquí se revoca). */
  @IsArray()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  @Matches(CODIGO_RE, {
    each: true,
    message: 'cada permiso debe tener el formato modulo.recurso.accion',
  })
  permisos!: string[];
}

export class HistorialQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limite?: number;
}

export interface PermisoResponse {
  id: string;
  codigo: string;
  modulo: string;
  recurso: string;
  accion: string;
  descripcion: string;
}

export interface CambioPermisosResponse {
  roleId: string;
  permisos: string[];
  otorgados: string[];
  revocados: string[];
}

export interface HistorialPermisoResponse {
  id: string;
  permiso: string;
  accion: 'otorgado' | 'revocado';
  realizadoPor: { id: string; name: string } | null;
  realizadoAt: string;
}
