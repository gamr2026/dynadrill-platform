import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { ALL_ROLE_CODES, RoleCode } from '@dyn/authz';

export class LoginDto {
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(256)
  password!: string;
}

/** La clave nueva debe ser distinta de la actual (lo verifica el servicio). */
export class ChangePasswordDto {
  @IsString()
  @MinLength(1)
  @MaxLength(256)
  currentPassword!: string;

  @IsString()
  @MinLength(10, { message: 'La clave nueva debe tener al menos 10 caracteres' })
  @MaxLength(256)
  newPassword!: string;
}

export class RefreshDto {
  @IsString()
  @MinLength(20)
  @MaxLength(200)
  refreshToken!: string;
}

export class LogoutDto {
  /** Si no viene, se cierran todas las sesiones del usuario. */
  @IsOptional()
  @IsString()
  @MinLength(20)
  @MaxLength(200)
  refreshToken?: string;
}

/** Se acepta `roleId` o `roleCode` (al menos uno), como en la demo. */
export class SwitchRoleDto {
  @ValidateIf((o: SwitchRoleDto) => o.roleCode === undefined)
  @IsUUID()
  roleId?: string;

  @ValidateIf((o: SwitchRoleDto) => o.roleId === undefined)
  @IsIn(ALL_ROLE_CODES as readonly string[])
  roleCode?: RoleCode;
}

/** Usuario que recibe el frontend al iniciar sesión (misma forma que la demo, ids ahora UUID). */
export interface SessionUser {
  id: string;
  name: string;
  email: string;
  roleId: string;
  roleName: string;
  roleCode: RoleCode;
  /** TRANSICIÓN: id numérico del usuario / del rol en el backend demo (null si no existía allí). */
  legacyId: number | null;
  roleLegacyId: number | null;
  /** Códigos de permiso del rol efectivo (RBAC): `<modulo>.<recurso>.<accion>`. */
  permissions: string[];
  /** true: debe elegir su clave (POST /auth/change-password) antes de usar el resto del sistema. */
  mustChangePassword: boolean;
}

export interface LoginResponse {
  accessToken: string;
  /** Opaco y rotativo: se cambia por uno nuevo en cada `POST /auth/refresh`. */
  refreshToken?: string;
  /** Segundos de vida del `accessToken`. */
  expiresIn: number;
  user: SessionUser;
}
