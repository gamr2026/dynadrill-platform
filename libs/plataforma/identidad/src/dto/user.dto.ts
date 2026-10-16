import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/** Vínculo de la persona con Dynadrill. Los valores son un `CHECK` en la base (`usuario_tipo_vinculo_check`). */
export const TIPOS_VINCULO = ['empleado', 'contratista', 'externo'] as const;
export type TipoVinculo = (typeof TIPOS_VINCULO)[number];

/**
 * Mismo contrato que `CreateUserInput` del frontend (nombres de campo de la demo). Los datos de RRHH
 * son opcionales: ningún flujo (login, roles, asignaciones) depende de ellos.
 */
export class CreateUserDto {
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsString()
  @MinLength(3)
  @MaxLength(60)
  username!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(256)
  password!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string;

  @IsUUID()
  roleId!: string;

  @IsBoolean()
  status!: boolean;

  /** La clave que se fija es provisional: la persona debe cambiarla en su primer ingreso. */
  @IsOptional()
  @IsBoolean()
  forceChangePassword?: boolean;

  /** Por defecto `empleado`. */
  @IsOptional()
  @IsIn(TIPOS_VINCULO)
  tipoVinculo?: TipoVinculo;

  @IsOptional()
  @IsIn(['Mecánico', 'Instrumental'])
  specialty?: string;

  @IsOptional() @IsString() @MaxLength(40) cedula?: string;
  @IsOptional() @IsString() @MaxLength(40) tipoIdentificacion?: string;
  @IsOptional() @IsString() @MaxLength(80) nacionalidad?: string;
  @IsOptional() @IsString() @MaxLength(120) apellidos?: string;
  @IsOptional() @IsString() @MaxLength(120) nombres?: string;
  @IsOptional() @IsString() @MaxLength(120) cargo?: string;
  @IsOptional() @IsString() @MaxLength(120) departamento?: string;
  @IsOptional() @IsString() @MaxLength(120) area?: string;
  @IsOptional() @IsDateString() fechaIngreso?: string;
  @IsOptional() @IsDateString() fechaSalida?: string | null;
  @IsOptional() @IsString() @MaxLength(200) causaSalidaEmpleado?: string;
  @IsOptional() @IsString() @MaxLength(80) tipoContrato?: string;
  @IsOptional() @IsString() @MaxLength(120) sucursal?: string;
  @IsOptional() @IsString() @MaxLength(120) tipoDiscapacidad?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) cargasActivas?: number;
  @IsOptional() @IsString() @MaxLength(80) categoria?: string;
  @IsOptional() @IsString() @MaxLength(80) centroCosto?: string;
  @IsOptional() @IsBoolean() empleadoActivo?: boolean;
}

/** Todo opcional. `password` solo se re-hashea si viene. */
export class UpdateUserDto {
  @IsOptional() @IsEmail() @MaxLength(254) email?: string;
  @IsOptional() @IsString() @MinLength(3) @MaxLength(60) username?: string;
  @IsOptional() @IsString() @MinLength(8) @MaxLength(256) password?: string;
  /** Solo tiene efecto junto con `password`: la clave fijada es provisional y debe cambiarse en el primer ingreso. */
  @IsOptional() @IsBoolean() forceChangePassword?: boolean;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(200) name?: string;
  @IsOptional() @IsString() @MaxLength(40) phone?: string;
  @IsOptional() @IsUUID() roleId?: string;
  @IsOptional() @IsBoolean() status?: boolean;
  @IsOptional() @IsIn(TIPOS_VINCULO) tipoVinculo?: TipoVinculo;
  @IsOptional() @IsIn(['Mecánico', 'Instrumental']) specialty?: string | null;

  @IsOptional() @IsString() @MaxLength(40) cedula?: string;
  @IsOptional() @IsString() @MaxLength(40) tipoIdentificacion?: string;
  @IsOptional() @IsString() @MaxLength(80) nacionalidad?: string;
  @IsOptional() @IsString() @MaxLength(120) apellidos?: string;
  @IsOptional() @IsString() @MaxLength(120) nombres?: string;
  @IsOptional() @IsString() @MaxLength(120) cargo?: string;
  @IsOptional() @IsString() @MaxLength(120) departamento?: string;
  @IsOptional() @IsString() @MaxLength(120) area?: string;
  @IsOptional() @IsDateString() fechaIngreso?: string | null;
  @IsOptional() @IsDateString() fechaSalida?: string | null;
  @IsOptional() @IsString() @MaxLength(200) causaSalidaEmpleado?: string;
  @IsOptional() @IsString() @MaxLength(80) tipoContrato?: string;
  @IsOptional() @IsString() @MaxLength(120) sucursal?: string;
  @IsOptional() @IsString() @MaxLength(120) tipoDiscapacidad?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) cargasActivas?: number;
  @IsOptional() @IsString() @MaxLength(80) categoria?: string;
  @IsOptional() @IsString() @MaxLength(80) centroCosto?: string;
  @IsOptional() @IsBoolean() empleadoActivo?: boolean;
}

export interface UserResponse {
  id: string;
  /** TRANSICIÓN: id numérico en el backend demo (null si no existía allí). */
  legacyId: number | null;
  email: string;
  username: string;
  name: string;
  phone: string;
  roleId: string;
  status: boolean;
  tipoVinculo: string;
  specialty: string | null;
  cedula?: string | null;
  tipoIdentificacion?: string | null;
  nacionalidad?: string | null;
  apellidos?: string | null;
  nombres?: string | null;
  cargo?: string | null;
  departamento?: string | null;
  area?: string | null;
  fechaIngreso?: string | null;
  fechaSalida?: string | null;
  causaSalidaEmpleado?: string | null;
  tipoContrato?: string | null;
  sucursal?: string | null;
  tipoDiscapacidad?: string | null;
  cargasActivas?: number | null;
  categoria?: string | null;
  centroCosto?: string | null;
  empleadoActivo?: boolean | null;
  createdAt: string;
  updatedAt: string;
}

export interface RolResponse {
  id: string;
  /** TRANSICIÓN: id numérico en el backend demo. */
  legacyId: number | null;
  name: string;
  code: string;
  description: string | null;
}

export interface UsuarioPorRolResponse {
  id: string;
  /** TRANSICIÓN: los módulos viejos asignan por este id numérico. */
  legacyId: number | null;
  name: string;
  specialty: string | null;
}
