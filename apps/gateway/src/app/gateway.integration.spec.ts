import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { generateKeyPairSync } from 'node:crypto';
import { createServer, IncomingHttpHeaders, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';

interface Seen {
  method?: string;
  url?: string;
  headers: IncomingHttpHeaders;
  body: string;
}

/** Servidor que registra lo último que recibió y responde con su nombre. */
function fakeUpstream(name: string) {
  const seen: Seen[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString(),
      });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ upstream: name }));
    });
  });
  return {
    server,
    seen,
    listen: () =>
      new Promise<number>((r) =>
        server.listen(0, '127.0.0.1', () => r((server.address() as AddressInfo).port)),
      ),
  };
}

const keys = () =>
  generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
const { publicKey, privateKey } = keys();

describe('Gateway (proxy real contra servidores falsos)', () => {
  let app: INestApplication;
  const plataforma = fakeUpstream('plataforma');
  const signer = new JwtService({
    privateKey,
    signOptions: { algorithm: 'RS256', issuer: 'dynadrill-plataforma' },
  });
  const validToken = () =>
    signer.sign({
      sub: '0192f7a4-5c1e-7b3a-9e21-8d4c6a1f0b77',
      email: 'a@b.c',
      roleId: 'r',
      roleCode: 'operador',
    });

  beforeAll(async () => {
    const plataformaPort = await plataforma.listen();
    Object.assign(process.env, {
      SERVICE_NAME: 'gateway',
      PORT: '3100',
      LOG_LEVEL: 'silent',
      JWT_PUBLIC_KEY: publicKey,
      PLATAFORMA_URL: `http://127.0.0.1:${plataformaPort}`,
      COMERCIAL_URL: 'http://127.0.0.1:1', // puerto cerrado: simula un contenedor caído
      RATE_LIMIT_PER_MINUTE: '60',
      LOGIN_RATE_LIMIT_PER_MINUTE: '4',
    });
    // el módulo valida el entorno al importarse, por eso se carga después de fijarlo
    const { AppModule } = await import('./app.module');
    const { configureGateway } = await import('./setup');
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication({ bodyParser: false });
    configureGateway(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    plataforma.server.close();
  });

  it('health lo responde el propio gateway, sin pasar por los destinos', async () => {
    await request(app.getHttpServer()).get('/health/live').expect(200, { status: 'ok' });
    expect(plataforma.seen).toHaveLength(0);
  });

  it('una ruta que ningún contenedor atiende responde 404 con el formato de error estándar, sin llegar a ningún destino', async () => {
    const antes = plataforma.seen.length;
    const res = await request(app.getHttpServer())
      .get('/api/facturacion-vieja/algo?x=1')
      .set('Authorization', `Bearer ${validToken()}`)
      .expect(404);
    expect(res.headers['content-type']).toMatch(/problem\+json/);
    expect(res.body).toMatchObject({ status: 404, statusCode: 404 });
    expect(plataforma.seen.length).toBe(antes);
  });

  it('hacia un contenedor nuevo exige token: 401 sin él y con uno inválido', async () => {
    const before = plataforma.seen.length;
    await request(app.getHttpServer()).get('/api/users').expect(401);
    await request(app.getHttpServer())
      .get('/api/users')
      .set('Authorization', 'Bearer basura')
      .expect(401);
    expect(plataforma.seen.length).toBe(before); // nunca llegó al destino
  });

  it('con token válido reenvía y conserva el request-id entrante', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/users')
      .set('Authorization', `Bearer ${validToken()}`)
      .set('x-request-id', 'req-abc-123')
      .expect(200);
    expect(res.body).toEqual({ upstream: 'plataforma' });
    expect(res.headers['x-request-id']).toBe('req-abc-123');
    expect(plataforma.seen.at(-1)?.headers['x-request-id']).toBe('req-abc-123');
  });

  it('login es público y el cuerpo POST llega intacto al destino', async () => {
    const body = { email: 'a@b.c', password: 'secreto-ñ-✓' };
    await request(app.getHttpServer()).post('/api/auth/login').send(body).expect(200);
    const got = plataforma.seen.at(-1);
    expect(got?.method).toBe('POST');
    expect(got?.url).toBe('/api/auth/login');
    expect(JSON.parse(got?.body ?? '')).toEqual(body);
  });

  it('jwks es público (sin token) y se enruta a la plataforma', async () => {
    await request(app.getHttpServer())
      .get('/api/auth/jwks')
      .expect(200, { upstream: 'plataforma' });
  });

  it('un contenedor caído responde 502 con el formato de error estándar', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/comercial/secuencias')
      .set('Authorization', `Bearer ${validToken()}`)
      .expect(502);
    expect(res.headers['content-type']).toMatch(/problem\+json/);
    expect(res.body).toMatchObject({ status: 502, statusCode: 502, title: 'BAD_GATEWAY' });
  });

  it('el login tiene un límite propio más estricto contra la fuerza bruta', async () => {
    // el test anterior de login ya consumió 1 de 4
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      statuses.push((await request(app.getHttpServer()).post('/api/auth/login').send({})).status);
    }
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(3);
    expect(statuses[0]).toBe(200);
    // otras rutas no se ven afectadas por el límite del login
    await request(app.getHttpServer()).get('/api/auth/jwks').expect(200);
  });

  it('limita las peticiones por minuto con 429', async () => {
    let limited = false;
    for (let i = 0; i < 60 && !limited; i++) {
      const res = await request(app.getHttpServer()).get('/api/lo-que-sea');
      limited = res.status === 429;
      if (limited) expect(res.body).toMatchObject({ status: 429, title: 'TOO_MANY_REQUESTS' });
    }
    expect(limited).toBe(true);
    // el health nunca se limita
    await request(app.getHttpServer()).get('/health/live').expect(200);
  });
});
