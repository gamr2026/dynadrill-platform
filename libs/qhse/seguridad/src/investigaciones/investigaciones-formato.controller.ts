import { Body, Controller, Param, ParseUUIDPipe, Put } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
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
import { Permission } from '@dyn/authz';
import { AuthUser, CurrentUser, RequirePermission } from '@dyn/common';
import { JornadaSuceso, SexoPersona, ZonaIncidente } from '../generated/client';
import { InvestigacionesFormatoService } from './investigaciones-formato.service';

const P = Permission;
const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const HORA = /^([01]\d|2[0-3]):[0-5]\d$/;

export class TrabajadorDto {
  @IsOptional() @IsUUID() usuarioId?: string;
  @IsOptional() @IsString() @MaxLength(200) apellidosNombres?: string;
  @IsOptional() @IsString() @MaxLength(30) cedula?: string;
  @IsOptional() @IsString() @MaxLength(150) cargo?: string;
  @IsOptional() @IsString() @MaxLength(300) direccion?: string;
  @IsOptional() @IsString() @MaxLength(50) telefono?: string;
  @IsOptional() @Matches(FECHA) fechaNacimiento?: string;
  @IsOptional() @IsIn(Object.values(SexoPersona)) sexo?: SexoPersona;
  @IsOptional() @Matches(FECHA) fechaIngreso?: string;
  @IsOptional() @IsString() @MaxLength(150) tipoVinculacion?: string;
  @IsOptional() @IsString() @MaxLength(200) oficioDesempenaba?: string;
  @IsOptional() @IsString() @MaxLength(150) jornadaHabitual?: string;
  @IsOptional() @IsInt() @Min(0) @Max(1200) tiempoExperienciaMeses?: number;
}

export class DetalleIncidenteDto {
  @IsOptional() @IsIn(Object.values(JornadaSuceso)) jornadaSuceso?: JornadaSuceso;
  @IsOptional() @IsString() @MaxLength(200) empresaDondeOcurrio?: string;
  @IsOptional() @IsString() @MaxLength(300) direccionOcurrencia?: string;
  @IsOptional() @IsIn(Object.values(ZonaIncidente)) zona?: ZonaIncidente;
  @IsOptional() @IsBoolean() oficioEraPropioDelCargo?: boolean;
  @IsOptional() @Matches(HORA) horaInicioJornada?: string;
  @IsOptional() @IsNumber() @Min(0) @Max(24) tiempoLaboradoPrevioHoras?: number;
  @IsOptional() @IsBoolean() seInformoOportunamente?: boolean;
  @IsOptional() @IsString() @MaxLength(200) tiempoAtencionMedica?: string;
  @IsOptional() @IsString() @MaxLength(200) centroMedico?: string;
  @IsOptional() @IsBoolean() causoMuerte?: boolean;
  @IsOptional() @Matches(FECHA) fechaMuerte?: string;
  @IsOptional() @IsString() @MaxLength(200) parteCuerpoAfectada?: string;
  @IsOptional() @IsString() @MaxLength(200) tipoLesionSufrida?: string;
  @IsOptional() @IsString() @MaxLength(300) factorQueOrigino?: string;
  @IsOptional() @IsInt() @Min(0) @Max(36500) totalDiasIncapacidad?: number;
  @IsOptional() @IsBoolean() continuaIncapacitado?: boolean;
  @IsOptional() @IsBoolean() sucesosSimilaresPrevios?: boolean;
  @IsOptional() @IsString() @MaxLength(2000) sucesosSimilaresDetalle?: string;
  @IsOptional() @IsString() @MaxLength(2000) danosMateriales?: string;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) totalPerdidasEconomicas?: number;
  @IsOptional() @IsString() @MaxLength(2000) danosMedioAmbiente?: string;
}

export class MiembroEquipoDto {
  @IsOptional() @IsUUID() usuarioId?: string;
  @IsOptional() @IsString() @MaxLength(200) nombreExterno?: string;
}
export class EquipoDto {
  @IsArray()
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => MiembroEquipoDto)
  miembros!: MiembroEquipoDto[];
}

export class TestigoDto {
  @IsString() @MaxLength(200) nombresApellidos!: string;
  @IsOptional() @IsString() @MaxLength(30) cedula?: string;
  @IsString() @MaxLength(4000) version!: string;
}
export class TestigosDto {
  @IsArray()
  @ArrayMaxSize(3)
  @ValidateNested({ each: true })
  @Type(() => TestigoDto)
  testigos!: TestigoDto[];
}

export class FactorEntornoDto {
  @IsString() @MaxLength(200) tipo!: string;
  @IsString() @MaxLength(300) fuente!: string;
  @IsBoolean() existeControl!: boolean;
  @IsBoolean() contribuyoAlSuceso!: boolean;
}
export class EntornoDto {
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => FactorEntornoDto)
  factores!: FactorEntornoDto[];
}

export class EvidenciasDto {
  @IsOptional() @IsString() @MaxLength(4000) evidenciasRecopiladas?: string;
  @IsOptional() @IsString() @MaxLength(4000) testimoniosResumen?: string;
}

/**
 * Formato de campo de la investigación (DYN-SGI-RE-034). Cada `PUT` reemplaza su sección completa; se edita solo mientras la investigación está
 * abierta o en investigación. Ruta pública `/api/v2/qhse/investigaciones/:id/...`, con `qhse.investigaciones.gestionar`.
 */
@Controller('qhse/investigaciones/:id')
export class InvestigacionesFormatoController {
  constructor(private readonly formato: InvestigacionesFormatoService) {}

  @RequirePermission(P.INVESTIGACIONES_GESTIONAR)
  @Put('trabajador')
  trabajador(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TrabajadorDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.formato.guardarTrabajador(id, dto, actor);
  }

  @RequirePermission(P.INVESTIGACIONES_GESTIONAR)
  @Put('incidente')
  incidente(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DetalleIncidenteDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.formato.guardarDetalle(id, dto, actor);
  }

  @RequirePermission(P.INVESTIGACIONES_GESTIONAR)
  @Put('equipo')
  equipo(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: EquipoDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.formato.guardarEquipo(id, dto.miembros, actor);
  }

  @RequirePermission(P.INVESTIGACIONES_GESTIONAR)
  @Put('testigos')
  testigos(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TestigosDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.formato.guardarTestigos(id, dto.testigos, actor);
  }

  @RequirePermission(P.INVESTIGACIONES_GESTIONAR)
  @Put('entorno')
  entorno(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: EntornoDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.formato.guardarEntorno(id, dto.factores, actor);
  }

  @RequirePermission(P.INVESTIGACIONES_GESTIONAR)
  @Put('evidencias')
  evidencias(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: EvidenciasDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.formato.guardarEvidencias(id, dto, actor);
  }
}
