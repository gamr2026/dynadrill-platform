import type { RoleCode } from '@dyn/authz';

/** Claims del JWT de acceso emitido por el módulo de identidad (RS256, 15 min). */
export interface JwtPayload {
  /** `identidad.usuario.id` (UUID). */
  sub: string;
  email: string;
  /** Nombre de la persona (para el seguimiento y los documentos). Los tokens anteriores no lo traen. */
  name?: string;
  /** `identidad.rol.id` (UUID). */
  roleId: string;
  roleCode: RoleCode;
  /** true si el token salió de `switch-role` (solo desarrollo). */
  impersonated?: boolean;
  /** TRANSICIÓN: ids numéricos del backend demo; el gateway los usa para traducir el token. */
  legacyId?: number;
  legacyRoleId?: number;
  /** Permisos del rol al emitir el token (RBAC). Un token sin esta clave se trata como sin permisos. */
  permissions?: string[];
  /** La persona aún debe cambiar su clave: solo puede usar las rutas marcadas `@AllowPendingPasswordChange`. */
  mustChangePassword?: boolean;
}

/** Lo que `JwtAuthGuard` deja en `request.user`; lo lee `@CurrentUser()`. */
export interface AuthUser {
  id: string;
  email: string;
  /** Nombre de la persona; si el token no lo trae, el correo. */
  name: string;
  roleId: string;
  roleCode: RoleCode;
  impersonated: boolean;
  /** Códigos de permiso del rol efectivo (`<modulo>.<recurso>.<accion>`). */
  permissions: string[];
  /** Ver `JwtPayload.mustChangePassword`. */
  mustChangePassword: boolean;
}

export function toAuthUser(payload: JwtPayload): AuthUser {
  return {
    id: payload.sub,
    email: payload.email,
    name: payload.name ?? payload.email,
    roleId: payload.roleId,
    roleCode: payload.roleCode,
    impersonated: payload.impersonated ?? false,
    permissions: payload.permissions ?? [],
    mustChangePassword: payload.mustChangePassword ?? false,
  };
}
