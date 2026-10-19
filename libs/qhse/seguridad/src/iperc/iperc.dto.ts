import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { MomentoControlIperc, TipoControlIperc } from '../generated/client';
import { NC_VALORES, ND_VALORES, NE_VALORES } from './gtc45';

export class ValoracionDto {
  @IsIn([...ND_VALORES]) nd!: number;
  @IsIn([...NE_VALORES]) ne!: number;
  @IsIn([...NC_VALORES]) nc!: number;
}

export class ControlDto {
  @IsIn(Object.values(MomentoControlIperc)) momento!: MomentoControlIperc;
  @IsIn(Object.values(TipoControlIperc)) tipo!: TipoControlIperc;
  @IsString() @MaxLength(2000) descripcion!: string;
}

export class PeligroDto {
  @IsString() @MaxLength(500) descripcion!: string;
  @IsUUID() clasificacionId!: string;
  @IsOptional() @IsString() @MaxLength(1000) fuenteRiesgo?: string;
  @IsOptional() @IsUUID() generadoEnId?: string;
  @IsOptional() @IsString() @MaxLength(2000) efectosPosibles?: string;
  @IsOptional() @IsString() @MaxLength(2000) controlExistenteFuente?: string;
  @IsOptional() @IsString() @MaxLength(2000) controlExistenteMedio?: string;
  @IsOptional() @IsString() @MaxLength(2000) controlExistenteIndividuo?: string;
  @IsOptional() @IsInt() @Min(0) numeroExpuestos?: number;
  @IsOptional() @IsString() @MaxLength(1000) peorConsecuencia?: string;
  @IsOptional() @IsBoolean() requisitoLegal?: boolean;
  @IsOptional() @IsString() @MaxLength(2000) seguimiento?: string;
  @IsOptional() @IsString() @MaxLength(2000) seguimientoResidual?: string;
  /** Riesgo inicial (sin los controles nuevos); los tres ejes o ninguno. */
  @IsOptional() @ValidateNested() @Type(() => ValoracionDto) inicial?: ValoracionDto;
  /** Riesgo residual (con los controles aplicados). */
  @IsOptional() @ValidateNested() @Type(() => ValoracionDto) residual?: ValoracionDto;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => ControlDto)
  controles?: ControlDto[];
}

export class TareaDto {
  @IsString() @MaxLength(1000) descripcion!: string;
  @IsBoolean() rutinaria!: boolean;
  @IsOptional() @IsString() @MaxLength(500) areaPuesto?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(30) @IsUUID(undefined, { each: true }) cargoIds?: string[];
  @IsArray()
  @ArrayMaxSize(60)
  @ValidateNested({ each: true })
  @Type(() => PeligroDto)
  peligros!: PeligroDto[];
}

/** Todo el contenido de una matriz: se guarda completo (reemplaza al anterior) mientras está en borrador o en evaluación. */
export class ContenidoMatrizDto {
  @IsArray()
  @ArrayMaxSize(80)
  @ValidateNested({ each: true })
  @Type(() => TareaDto)
  tareas!: TareaDto[];
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsUUID(undefined, { each: true })
  evaluadorIds?: string[];
}

export class CrearActividadDto {
  @IsUUID() procesoId!: string;
  @IsUUID() zonaId!: string;
  @IsString() @MaxLength(300) nombre!: string;
}

export class AdjuntarDto {
  @IsIn(['procedimiento', 'ats']) tipo!: 'procedimiento' | 'ats';
  /** Archivo subido antes a `/api/archivos` con el módulo `qhse_iperc_documento`. */
  @IsUUID() archivoId!: string;
}

export class RechazarDto {
  @IsString() @MaxLength(500) motivo!: string;
}

export class AgregarCatalogoDto {
  @IsString() @MaxLength(200) nombre!: string;
}

export class CoberturaDto {
  /** Actividades de la matriz maestra que exige el tipo de servicio (reemplaza la lista). */
  @IsArray() @ArrayMaxSize(200) @IsUUID(undefined, { each: true }) actividadIds!: string[];
}
