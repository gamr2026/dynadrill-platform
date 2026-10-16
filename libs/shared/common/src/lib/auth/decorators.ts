import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { RoleCode } from '@dyn/authz';
import type { AuthUser } from './auth-user';

export const IS_PUBLIC_KEY = 'dyn:isPublic';
export const ROLES_KEY = 'dyn:requiredRoles';
export const ANY_AUTHENTICATED_KEY = 'dyn:anyAuthenticated';
export const PERMISSIONS_KEY = 'dyn:requiredPermissions';
export const ALLOW_PENDING_PASSWORD_KEY = 'dyn:allowPendingPasswordChange';

/** Ruta sin token: login, refresh, health. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/**
 * Restringe a los roles listados. Se pasa la matriz de `ModuleRoles` de `@dyn/authz`.
 * @example @Roles(...ModuleRoles.qhse)
 */
export const Roles = (...roles: RoleCode[]) => SetMetadata(ROLES_KEY, roles);

/**
 * Exige al menos UNO de los permisos indicados (RBAC). Los permisos de un rol los edita un administrador
 * desde la app, por eso este es el decorador preferido frente a `@Roles`, que fija los roles en el código.
 * @example @RequirePermission(Permission.IPERC_APROBAR)
 */
export const RequirePermission = (...permissions: string[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);

/**
 * Cualquier usuario autenticado, sin importar el rol. Es una decisión explícita:
 * una ruta sin `@Public`, `@RequirePermission`, `@Roles` ni `@AnyAuthenticated` se rechaza (cierre por defecto,
 * documento de arquitectura cap. 10.4 "autorización a nivel de función").
 */
export const AnyAuthenticated = () => SetMetadata(ANY_AUTHENTICATED_KEY, true);

/**
 * La ruta se puede usar aunque la persona aún deba cambiar su clave (cambiarla, ver quién es, cerrar sesión).
 * Cualquier otra ruta responde 403 con código `PASSWORD_CHANGE_REQUIRED` mientras el cambio esté pendiente.
 */
export const AllowPendingPasswordChange = () => SetMetadata(ALLOW_PENDING_PASSWORD_KEY, true);

/** Inyecta el usuario autenticado; `@CurrentUser('id')` devuelve solo esa propiedad. */
export const CurrentUser = createParamDecorator(
  (data: keyof AuthUser | undefined, ctx: ExecutionContext) => {
    const user = ctx.switchToHttp().getRequest<{ user?: AuthUser }>().user;
    if (!user) return undefined;
    return data ? user[data] : user;
  },
);
