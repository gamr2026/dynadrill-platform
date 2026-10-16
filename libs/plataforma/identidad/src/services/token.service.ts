import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, createPublicKey, KeyObject, randomBytes } from 'node:crypto';
import * as jwt from 'jsonwebtoken';
import { normalizePem } from '@dyn/config';
import type { JwtPayload } from '@dyn/common';
import { sha256Hex } from '@dyn/utils';

export interface AccessTokenInput {
  userId: string;
  email: string;
  name?: string;
  roleId: string;
  roleCode: JwtPayload['roleCode'];
  impersonated?: boolean;
  /** TRANSICIÓN: ids del backend demo, para que el gateway traduzca el token. */
  legacyId?: number | null;
  legacyRoleId?: number | null;
  /** Permisos del rol al emitir el token; los servicios autorizan con ellos sin consultar la base. */
  permissions?: string[];
  /** Cambio de clave pendiente (ver `JwtPayload.mustChangePassword`). */
  mustChangePassword?: boolean;
}

/** JWT de acceso (RS256) y refresh tokens opacos. Los refresh nunca se guardan: solo su SHA-256. */
@Injectable()
export class TokenService {
  private readonly privateKey: string;
  private readonly publicKey: KeyObject;
  private readonly issuer: string;
  readonly accessTtlSeconds: number;
  readonly refreshTtlSeconds: number;
  /** Identifica la llave en el JWT y en el JWKS (permite rotarlas sin cortar sesiones). */
  readonly kid: string;

  constructor(cfg: ConfigService) {
    this.privateKey = normalizePem(cfg.getOrThrow<string>('JWT_PRIVATE_KEY'));
    this.publicKey = createPublicKey(this.privateKey);
    this.issuer = cfg.get<string>('JWT_ISSUER') ?? 'dynadrill-plataforma';
    this.accessTtlSeconds = Number(cfg.get('JWT_ACCESS_TTL_SECONDS') ?? 900);
    this.refreshTtlSeconds = Number(cfg.get('JWT_REFRESH_TTL_SECONDS') ?? 60 * 60 * 24 * 7);
    this.kid = createHash('sha256')
      .update(this.publicKey.export({ type: 'spki', format: 'der' }))
      .digest('hex')
      .slice(0, 16);
  }

  signAccessToken(input: AccessTokenInput, ttlSeconds = this.accessTtlSeconds): string {
    const payload: Omit<JwtPayload, 'impersonated'> & { impersonated?: true } = {
      sub: input.userId,
      email: input.email,
      ...(input.name ? { name: input.name } : {}),
      roleId: input.roleId,
      roleCode: input.roleCode,
      ...(input.impersonated ? { impersonated: true as const } : {}),
      ...(input.legacyId != null ? { legacyId: input.legacyId } : {}),
      ...(input.legacyRoleId != null ? { legacyRoleId: input.legacyRoleId } : {}),
      permissions: input.permissions ?? [],
      ...(input.mustChangePassword ? { mustChangePassword: true as const } : {}),
    };
    return jwt.sign(payload, this.privateKey, {
      algorithm: 'RS256',
      issuer: this.issuer,
      expiresIn: ttlSeconds,
      keyid: this.kid,
    });
  }

  /** Refresh token nuevo: 256 bits aleatorios. Se entrega al cliente; en la base va solo el hash. */
  newRefreshToken(): { token: string; hash: string; expiresAt: Date } {
    const token = randomBytes(32).toString('base64url');
    return {
      token,
      hash: this.hashRefreshToken(token),
      expiresAt: new Date(Date.now() + this.refreshTtlSeconds * 1000),
    };
  }

  hashRefreshToken(token: string): string {
    return sha256Hex(token);
  }

  /** JWK público para `GET /api/auth/jwks` (los demás servicios pueden validar sin compartir PEM). */
  jwks(): { keys: Array<Record<string, unknown>> } {
    return {
      keys: [
        { ...this.publicKey.export({ format: 'jwk' }), kid: this.kid, alg: 'RS256', use: 'sig' },
      ],
    };
  }
}
