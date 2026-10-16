import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import type { RoleCode } from '@dyn/authz';
import { AuthUser, JwtPayload, toAuthUser } from './auth-user';
import {
  ALLOW_PENDING_PASSWORD_KEY,
  ANY_AUTHENTICATED_KEY,
  IS_PUBLIC_KEY,
  PERMISSIONS_KEY,
  ROLES_KEY,
} from './decorators';

type AuthedRequest = Request & { user?: AuthUser };

/**
 * Guard global. Exige `Authorization: Bearer <jwt>` válido (RS256, clave pública) salvo en rutas
 * `@Public()`. Es stateless: valida la firma localmente, sin consultar a la plataforma.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const [type, token] = request.headers.authorization?.split(' ') ?? [];
    if (type !== 'Bearer' || !token) throw new UnauthorizedException('Falta el token de acceso');

    try {
      const payload = await this.jwt.verifyAsync<JwtPayload>(token);
      request.user = toAuthUser(payload);
      return true;
    } catch {
      throw new UnauthorizedException('Token inválido o expirado');
    }
  }
}

/**
 * Guard global que corre después de `JwtAuthGuard`. Cierre por defecto: toda ruta debe declarar
 * `@Public()`, `@RequirePermission(...)`, `@Roles(...)` o `@AnyAuthenticated()`; si no declara nada responde 403.
 * El acceso de Superadmin / Jefe de Base se expresa listándolos (helper `withAdmins`), no con comodines.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) return true;

    // Cambio de clave pendiente: solo las rutas que lo permiten expresamente (cambiarla, /me, logout).
    const pendiente = context.switchToHttp().getRequest<AuthedRequest>().user?.mustChangePassword;
    if (
      pendiente &&
      !this.reflector.getAllAndOverride<boolean>(ALLOW_PENDING_PASSWORD_KEY, targets)
    ) {
      throw new ForbiddenException({
        message: 'Debe cambiar su clave antes de continuar',
        code: 'PASSWORD_CHANGE_REQUIRED',
      });
    }

    const permissions = this.reflector.getAllAndOverride<string[] | undefined>(
      PERMISSIONS_KEY,
      targets,
    );
    if (permissions?.length) {
      const user = context.switchToHttp().getRequest<AuthedRequest>().user;
      if (!user) throw new ForbiddenException('Sin permisos asignados');
      if (!permissions.some((p) => user.permissions.includes(p))) {
        throw new ForbiddenException('Su rol no tiene permiso para esta acción');
      }
      return true;
    }

    const roles = this.reflector.getAllAndOverride<RoleCode[] | undefined>(ROLES_KEY, targets);
    const anyAuthenticated = this.reflector.getAllAndOverride<boolean>(
      ANY_AUTHENTICATED_KEY,
      targets,
    );

    if (!roles?.length) {
      if (anyAuthenticated) return true;
      throw new ForbiddenException('La ruta no declara una política de acceso');
    }

    const roleCode = context.switchToHttp().getRequest<AuthedRequest>().user?.roleCode;
    if (!roleCode) throw new ForbiddenException('Sin rol asignado');
    if (!roles.includes(roleCode)) {
      throw new ForbiddenException('Su rol no tiene permiso para esta acción');
    }
    return true;
  }
}
