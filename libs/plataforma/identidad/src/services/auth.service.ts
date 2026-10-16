import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { RoleCode } from '@dyn/authz';
import type { AuthUser } from '@dyn/common';
import { uuidv7 } from '@dyn/utils';
import type {
  ChangePasswordDto,
  LoginResponse,
  LoginDto,
  SessionUser,
  SwitchRoleDto,
} from '../dto/auth.dto';
import type { Rol, Usuario } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';

export interface ClientContext {
  ip?: string;
  userAgent?: string;
}

/** Mensaje único: nunca se distingue entre "no existe", "inactivo", "bloqueado" o "clave incorrecta". */
const INVALID = 'Credenciales inválidas';

/** Un refresh token recién rotado puede llegar dos veces (dos pestañas); no se trata como robo. */
const REUSE_GRACE_MS = 10_000;

type UsuarioConRol = Usuario & { rol: Rol };

@Injectable()
export class AuthService {
  private readonly maxAttempts: number;
  private readonly lockMs: number;
  private readonly devRoleSwitch: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    cfg: ConfigService,
  ) {
    this.maxAttempts = Number(cfg.get('LOGIN_MAX_ATTEMPTS') ?? 5);
    this.lockMs = Number(cfg.get('LOGIN_LOCK_MINUTES') ?? 15) * 60_000;
    this.devRoleSwitch = String(cfg.get('DEV_ROLE_SWITCH')) === 'true';
  }

  async login(dto: LoginDto, ctx: ClientContext = {}): Promise<LoginResponse> {
    const email = dto.email.trim().toLowerCase();
    const user = await this.prisma.usuario.findUnique({ where: { email }, include: { rol: true } });

    if (!user || !user.activo || !user.passwordHash) {
      await this.passwords.equalizeTiming(dto.password);
      throw new UnauthorizedException(INVALID);
    }

    if (user.bloqueadoHasta && user.bloqueadoHasta > new Date()) {
      // Cuenta bloqueada: se rechaza aunque la clave sea correcta, sin revelar el bloqueo.
      await this.passwords.equalizeTiming(dto.password);
      throw new UnauthorizedException(INVALID);
    }

    if (!(await this.passwords.verify(dto.password, user.passwordHash))) {
      await this.registerFailure(user);
      throw new UnauthorizedException(INVALID);
    }

    // Credenciales correctas: limpia el bloqueo y migra el hash si era bcrypt o de parámetros viejos.
    await this.prisma.usuario.update({
      where: { id: user.id },
      data: {
        ultimoAccesoAt: new Date(),
        intentosFallidos: 0,
        bloqueadoHasta: null,
        ...(this.passwords.needsRehash(user.passwordHash)
          ? { passwordHash: await this.passwords.hash(dto.password) }
          : {}),
      },
    });

    return this.issueSession(user, ctx);
  }

  /**
   * Cambia un refresh token por un par nuevo. Cada refresh token sirve una sola vez: si se presenta
   * uno ya usado (fuera de la ventana de gracia) se asume robo y se cierran todas las sesiones.
   */
  async refresh(refreshToken: string, ctx: ClientContext = {}): Promise<LoginResponse> {
    const hash = this.tokens.hashRefreshToken(refreshToken);
    const sesion = await this.prisma.sesion.findUnique({
      where: { tokenHash: hash },
      include: { usuario: { include: { rol: true } } },
    });
    if (!sesion) throw new UnauthorizedException('Sesión inválida');

    const now = new Date();
    if (sesion.revocadoAt) {
      if (now.getTime() - sesion.revocadoAt.getTime() > REUSE_GRACE_MS) {
        await this.prisma.sesion.updateMany({
          where: { usuarioId: sesion.usuarioId, revocadoAt: null },
          data: { revocadoAt: now },
        });
      }
      throw new UnauthorizedException('Sesión inválida');
    }
    if (sesion.expiraAt <= now || !sesion.usuario.activo) {
      throw new UnauthorizedException('Sesión inválida');
    }

    // Revoca solo si sigue vigente: si dos refresh llegan a la vez, solo uno gana la rotación.
    const claimed = await this.prisma.sesion.updateMany({
      where: { id: sesion.id, revocadoAt: null },
      data: { revocadoAt: now },
    });
    if (claimed.count === 0) throw new UnauthorizedException('Sesión inválida');

    return this.issueSession(sesion.usuario, ctx);
  }

  /** Con `refreshToken` cierra esa sesión; sin él, todas las del usuario. */
  async logout(current: AuthUser, refreshToken?: string): Promise<{ ok: true }> {
    await this.prisma.sesion.updateMany({
      where: {
        usuarioId: current.id,
        revocadoAt: null,
        ...(refreshToken ? { tokenHash: this.tokens.hashRefreshToken(refreshToken) } : {}),
      },
      data: { revocadoAt: new Date() },
    });
    return { ok: true };
  }

  /**
   * La persona elige su clave. Exige la actual, que la nueva sea distinta, y cierra TODAS las sesiones anteriores
   * (incluida la provisional); devuelve una sesión nueva sin la marca de cambio pendiente.
   */
  async changePassword(
    current: AuthUser,
    dto: ChangePasswordDto,
    ctx: ClientContext = {},
  ): Promise<LoginResponse> {
    const user = await this.prisma.usuario.findUnique({
      where: { id: current.id },
      include: { rol: true },
    });
    if (!user || !user.activo || !user.passwordHash) {
      throw new UnauthorizedException('La sesión ya no es válida');
    }
    if (!(await this.passwords.verify(dto.currentPassword, user.passwordHash))) {
      throw new UnauthorizedException('La clave actual no es correcta');
    }
    if (dto.currentPassword === dto.newPassword) {
      throw new BadRequestException('La clave nueva debe ser distinta de la actual');
    }
    const passwordHash = await this.passwords.hash(dto.newPassword);
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.sesion.updateMany({
        where: { usuarioId: user.id, revocadoAt: null },
        data: { revocadoAt: new Date() },
      });
      return tx.usuario.update({
        where: { id: user.id },
        data: {
          passwordHash,
          debeCambiarClave: false,
          intentosFallidos: 0,
          bloqueadoHasta: null,
          updatedBy: user.id,
        },
        include: { rol: true },
      });
    });
    return this.issueSession(updated, ctx);
  }

  async me(current: AuthUser): Promise<SessionUser> {
    const user = await this.prisma.usuario.findUnique({
      where: { id: current.id },
      include: { rol: true },
    });
    if (!user || !user.activo) throw new UnauthorizedException('La sesión ya no es válida');

    // Un token de switch-role refleja el rol impersonado, no el real del usuario.
    if (current.impersonated) {
      const rol = await this.prisma.rol.findUnique({ where: { id: current.roleId } });
      if (rol) return this.toSessionUser(user, rol, await this.permisosDe(rol.id));
    }
    return this.toSessionUser(user, user.rol, await this.permisosDe(user.rol.id));
  }

  /**
   * Re-emite el token con otro rol, sin re-login. SOLO para demostrar el flujo de Pumping (cada paso
   * lo actúa un rol distinto). Sin refresh token y con la vida normal del access token.
   */
  async switchRole(current: AuthUser, target: SwitchRoleDto): Promise<LoginResponse> {
    if (!this.devRoleSwitch) {
      throw new ForbiddenException(
        'El cambio de rol sin re-login está deshabilitado (DEV_ROLE_SWITCH=false)',
      );
    }
    const rol = target.roleId
      ? await this.prisma.rol.findUnique({ where: { id: target.roleId } })
      : await this.prisma.rol.findUnique({ where: { codigo: target.roleCode } });
    if (!rol) throw new NotFoundException('No existe el rol indicado');

    const user = await this.prisma.usuario.findUnique({ where: { id: current.id } });
    if (!user || !user.activo) throw new UnauthorizedException('La sesión ya no es válida');

    const permissions = await this.permisosDe(rol.id);
    const accessToken = this.tokens.signAccessToken({
      userId: user.id,
      email: user.email,
      name: user.nombre,
      roleId: rol.id,
      roleCode: rol.codigo as RoleCode,
      impersonated: true,
      legacyId: user.legacyId,
      legacyRoleId: rol.legacyId,
      permissions,
      mustChangePassword: user.debeCambiarClave,
    });
    return {
      accessToken,
      expiresIn: this.tokens.accessTtlSeconds,
      user: this.toSessionUser(user, rol, permissions),
    };
  }

  jwks() {
    return this.tokens.jwks();
  }

  private async registerFailure(user: Usuario): Promise<void> {
    const attempts = user.intentosFallidos + 1;
    const lock = attempts >= this.maxAttempts;
    await this.prisma.usuario.update({
      where: { id: user.id },
      data: {
        intentosFallidos: lock ? 0 : attempts,
        bloqueadoHasta: lock ? new Date(Date.now() + this.lockMs) : null,
      },
    });
  }

  private async issueSession(user: UsuarioConRol, ctx: ClientContext): Promise<LoginResponse> {
    const refresh = this.tokens.newRefreshToken();
    await this.prisma.sesion.create({
      data: {
        id: uuidv7(),
        usuarioId: user.id,
        tokenHash: refresh.hash,
        expiraAt: refresh.expiresAt,
        ip: ctx.ip ?? null,
        userAgent: ctx.userAgent?.slice(0, 500) ?? null,
      },
    });
    const permissions = await this.permisosDe(user.rol.id);
    const accessToken = this.tokens.signAccessToken({
      userId: user.id,
      email: user.email,
      name: user.nombre,
      roleId: user.rol.id,
      roleCode: user.rol.codigo as RoleCode,
      legacyId: user.legacyId,
      legacyRoleId: user.rol.legacyId,
      permissions,
      mustChangePassword: user.debeCambiarClave,
    });
    return {
      accessToken,
      refreshToken: refresh.token,
      expiresIn: this.tokens.accessTtlSeconds,
      user: this.toSessionUser(user, user.rol, permissions),
    };
  }

  /** Códigos de permiso vigentes de un rol. Se lee en cada emisión de token: un refresh trae lo último. */
  private async permisosDe(rolId: string): Promise<string[]> {
    const rows = await this.prisma.rolPermiso.findMany({
      where: { rolId },
      select: { permiso: { select: { codigo: true } } },
    });
    return rows.map((r) => r.permiso.codigo).sort();
  }

  private toSessionUser(user: Usuario, rol: Rol, permissions: string[]): SessionUser {
    return {
      id: user.id,
      name: user.nombre,
      email: user.email,
      roleId: rol.id,
      roleName: rol.nombre,
      roleCode: rol.codigo as RoleCode,
      legacyId: user.legacyId,
      roleLegacyId: rol.legacyId,
      permissions,
      mustChangePassword: user.debeCambiarClave,
    };
  }
}
