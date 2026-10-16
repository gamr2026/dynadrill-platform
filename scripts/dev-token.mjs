// Firma un token de acceso de desarrollo (RS256) con la llave de infra/keys.
// Uso: node scripts/dev-token.mjs [roleCode] [userId]
//      node scripts/dev-token.mjs superadmin
import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

const roleCode = process.argv[2] ?? 'superadmin';
const userId = process.argv[3] ?? '0192f7a4-5c1e-7b3a-9e21-8d4c6a1f0b77';
const now = Math.floor(Date.now() / 1000);
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

const header = b64({ alg: 'RS256', typ: 'JWT' });
const payload = b64({
  sub: userId,
  email: 'dev@dynadrill.local',
  roleId: 'dev-role',
  roleCode,
  iss: 'dynadrill-plataforma',
  iat: now,
  exp: now + 3600,
});
const signature = createSign('RSA-SHA256')
  .update(`${header}.${payload}`)
  .sign(readFileSync('infra/keys/jwt-private.pem'))
  .toString('base64url');
process.stdout.write(`${header}.${payload}.${signature}`);
