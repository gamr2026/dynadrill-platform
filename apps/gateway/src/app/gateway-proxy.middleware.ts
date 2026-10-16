import {
  ForbiddenException,
  Injectable,
  Logger,
  NestMiddleware,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as jsonwebtoken from 'jsonwebtoken';
import type { NextFunction, Request, Response } from 'express';
import { createProxyMiddleware, RequestHandler } from 'http-proxy-middleware';
import type { GatewayEnv } from './env';
import { isPublicPath, PATH_REWRITE, resolveTarget, TargetUrls } from './routes';

type GatewayRequest = Request & { id?: string };

/**
 * Único punto de entrada de `/api/*`: resuelve el contenedor por prefijo, valida el token cuando el
 * destino es un contenedor nuevo y reenvía la petición tal cual (sin tocar el cuerpo).
 *
 * Hacia `demo-legacy` NO valida: esos tokens los emite y entiende la demo (HS256), no la plataforma.
 */
@Injectable()
export class GatewayProxyMiddleware implements NestMiddleware {
  private readonly logger = new Logger(GatewayProxyMiddleware.name);
  private readonly urls: TargetUrls;
  private readonly proxies = new Map<string, RequestHandler>();
  private readonly timeoutMs: number;
  private readonly legacySecret?: string;

  constructor(
    cfg: ConfigService<GatewayEnv, true>,
    private readonly jwt: JwtService,
  ) {
    this.urls = {
      legacy: cfg.get('LEGACY_URL', { infer: true }),
      plataforma: cfg.get('PLATAFORMA_URL', { infer: true }),
      comercial: cfg.get('COMERCIAL_URL', { infer: true }),
      operaciones: cfg.get('OPERACIONES_URL', { infer: true }),
      qhse: cfg.get('QHSE_URL', { infer: true }),
    };
    this.timeoutMs = cfg.get('PROXY_TIMEOUT_MS', { infer: true });
    this.legacySecret = cfg.get('LEGACY_JWT_SECRET', { infer: true });
  }

  async use(req: GatewayRequest, res: Response, next: NextFunction): Promise<void> {
    const pathname = req.originalUrl.split('?')[0];
    const target = resolveTarget(pathname, this.urls);

    if (target.name !== 'legacy' && !isPublicPath(pathname)) {
      await this.assertValidToken(req);
    }

    if (target.name === 'legacy') await this.bridgeToLegacy(req);

    this.proxyFor(target.url)(req, res, next);
  }

  /**
   * TRANSICIÓN (puente de identidad). El frontend ya inicia sesión en el backend nuevo, pero los módulos
   * que siguen en la demo solo entienden SU token (HS256, ids numéricos). Si la petición trae un token
   * nuevo válido con `legacyId`, se reemplaza por uno equivalente firmado con el secreto de la demo y
   * con la misma vigencia. Cualquier otro caso pasa intacto: tokens propios de la demo, tokens inválidos
   * (la demo los rechazará) o usuarios sin equivalente en la demo. Se retira cuando el último módulo migre.
   */
  private async bridgeToLegacy(req: Request): Promise<void> {
    if (!this.legacySecret) return;
    const [type, token] = req.headers.authorization?.split(' ') ?? [];
    if (type !== 'Bearer' || !token) return;

    let claims: Record<string, unknown>;
    try {
      claims = await this.jwt.verifyAsync<Record<string, unknown>>(token);
    } catch {
      return; // no es un token de la plataforma nueva
    }
    // Cambio de clave pendiente: la demo no conoce esa regla, así que se corta aquí (no se le traduce el token).
    if (claims['mustChangePassword']) {
      throw new ForbiddenException({
        message: 'Debe cambiar su clave antes de continuar',
        code: 'PASSWORD_CHANGE_REQUIRED',
      });
    }
    if (typeof claims['legacyId'] !== 'number') return;

    // Un token sin vencimiento no se traduce: nunca se fabrica uno eterno para la demo.
    const exp = Number(claims['exp']);
    if (!Number.isFinite(exp)) return;
    const remaining = Math.max(1, exp - Math.floor(Date.now() / 1000));
    req.headers.authorization = `Bearer ${jsonwebtoken.sign(
      {
        sub: claims['legacyId'],
        email: claims['email'],
        roleId: typeof claims['legacyRoleId'] === 'number' ? claims['legacyRoleId'] : 0,
        roleCode: claims['roleCode'],
        ...(claims['impersonated'] ? { impersonated: true } : {}),
      },
      this.legacySecret,
      { algorithm: 'HS256', expiresIn: remaining },
    )}`;
  }

  private async assertValidToken(req: Request): Promise<void> {
    const [type, token] = req.headers.authorization?.split(' ') ?? [];
    if (type !== 'Bearer' || !token) throw new UnauthorizedException('Falta el token de acceso');
    try {
      await this.jwt.verifyAsync(token);
    } catch {
      throw new UnauthorizedException('Token inválido o expirado');
    }
  }

  private proxyFor(target: string): RequestHandler {
    let proxy = this.proxies.get(target);
    if (!proxy) {
      proxy = createProxyMiddleware({
        target,
        pathRewrite: PATH_REWRITE,
        xfwd: true,
        proxyTimeout: this.timeoutMs,
        timeout: this.timeoutMs,
        on: {
          proxyReq: (proxyReq, req) => {
            const id = (req as GatewayRequest).id;
            if (id) proxyReq.setHeader('x-request-id', id);
          },
          error: (err, req, res) => {
            const id = (req as GatewayRequest).id;
            this.logger.error(`[${id}] ${req.method} ${req.url} → ${target}: ${err.message}`);
            const response = res as Response;
            if (response.headersSent || !response.writeHead) return;
            const status = /timeout|ETIMEDOUT/i.test(err.message) ? 504 : 502;
            response.writeHead(status, {
              'content-type': 'application/problem+json; charset=utf-8',
            });
            response.end(
              JSON.stringify({
                type: `https://dynadrill.com/problemas/${status}`,
                title: status === 504 ? 'GATEWAY_TIMEOUT' : 'BAD_GATEWAY',
                status,
                statusCode: status,
                detail: 'El servicio de destino no está disponible',
                message: 'El servicio de destino no está disponible',
                instance: req.url,
                requestId: id,
                timestamp: new Date().toISOString(),
              }),
            );
          },
        },
      });
      this.proxies.set(target, proxy);
    }
    return proxy;
  }
}
