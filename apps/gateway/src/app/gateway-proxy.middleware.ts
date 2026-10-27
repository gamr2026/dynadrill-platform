import {
  Injectable,
  Logger,
  NestMiddleware,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { NextFunction, Request, Response } from 'express';
import { createProxyMiddleware, RequestHandler } from 'http-proxy-middleware';
import type { GatewayEnv } from './env';
import { isPublicPath, PATH_REWRITE, resolveTarget, TargetUrls } from './routes';

type GatewayRequest = Request & { id?: string };

/**
 * Único punto de entrada de `/api/*`: resuelve el contenedor por prefijo, valida el token (salvo las rutas públicas)
 * y reenvía la petición tal cual (sin tocar el cuerpo). Una ruta que ningún contenedor atiende responde 404.
 */
@Injectable()
export class GatewayProxyMiddleware implements NestMiddleware {
  private readonly logger = new Logger(GatewayProxyMiddleware.name);
  private readonly urls: TargetUrls;
  private readonly proxies = new Map<string, RequestHandler>();
  private readonly timeoutMs: number;

  constructor(
    cfg: ConfigService<GatewayEnv, true>,
    private readonly jwt: JwtService,
  ) {
    this.urls = {
      plataforma: cfg.get('PLATAFORMA_URL', { infer: true }),
      comercial: cfg.get('COMERCIAL_URL', { infer: true }),
      operaciones: cfg.get('OPERACIONES_URL', { infer: true }),
      qhse: cfg.get('QHSE_URL', { infer: true }),
    };
    this.timeoutMs = cfg.get('PROXY_TIMEOUT_MS', { infer: true });
  }

  async use(req: GatewayRequest, res: Response, next: NextFunction): Promise<void> {
    const pathname = req.originalUrl.split('?')[0];
    const target = resolveTarget(pathname, this.urls);

    if (!target) throw new NotFoundException('La ruta no existe');

    if (!isPublicPath(pathname)) await this.assertValidToken(req);

    this.proxyFor(target.url)(req, res, next);
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
