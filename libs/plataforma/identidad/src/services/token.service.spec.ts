import { ConfigService } from '@nestjs/config';
import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import * as jwt from 'jsonwebtoken';
import { sha256Hex } from '@dyn/utils';
import { TokenService } from './token.service';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const cfg = new ConfigService({
  JWT_PRIVATE_KEY: privateKey,
  JWT_ISSUER: 'dynadrill-plataforma',
  JWT_ACCESS_TTL_SECONDS: '900',
  JWT_REFRESH_TTL_SECONDS: '604800',
});

describe('TokenService', () => {
  const svc = new TokenService(cfg);
  const input = { userId: 'u-1', email: 'a@b.c', roleId: 'r-1', roleCode: 'operador' as const };

  it('firma un JWT RS256 verificable con la clave pública, con kid, issuer y 15 min de vida', () => {
    const token = svc.signAccessToken(input);
    const decoded = jwt.verify(token, publicKey, {
      algorithms: ['RS256'],
      issuer: 'dynadrill-plataforma',
      complete: true,
    });
    expect(decoded.header).toMatchObject({ alg: 'RS256', kid: svc.kid });
    const p = decoded.payload as jwt.JwtPayload;
    expect(p).toMatchObject({ sub: 'u-1', email: 'a@b.c', roleId: 'r-1', roleCode: 'operador' });
    expect(p.exp! - p.iat!).toBe(900);
    expect(p).not.toHaveProperty('impersonated');
  });

  it('marca los tokens de switch-role como impersonados', () => {
    const p = jwt.decode(svc.signAccessToken({ ...input, impersonated: true })) as jwt.JwtPayload;
    expect(p['impersonated']).toBe(true);
  });

  it('el refresh token es aleatorio, de 256 bits, y solo se guarda su SHA-256', () => {
    const a = svc.newRefreshToken();
    const b = svc.newRefreshToken();
    expect(a.token).not.toBe(b.token);
    expect(Buffer.from(a.token, 'base64url')).toHaveLength(32);
    expect(a.hash).toBe(sha256Hex(a.token));
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.expiresAt.getTime()).toBeGreaterThan(Date.now() + 6 * 24 * 3600 * 1000);
  });

  it('el JWKS publica solo la clave pública y coincide con el kid del token', () => {
    const { keys } = svc.jwks();
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ kty: 'RSA', alg: 'RS256', use: 'sig', kid: svc.kid });
    expect(keys[0]).not.toHaveProperty('d'); // nunca el exponente privado
    const rebuilt = createPublicKey({ key: keys[0] as never, format: 'jwk' }).export({
      type: 'spki',
      format: 'pem',
    });
    expect(rebuilt).toBe(publicKey);
  });
});
