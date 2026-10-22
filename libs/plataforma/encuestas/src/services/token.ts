import { createHash, randomBytes } from 'node:crypto';

/** Forma de un token válido (base64url de 32 bytes mide 43 caracteres; el rango deja margen). */
export const TOKEN_VALIDO = /^[A-Za-z0-9_-]{20,128}$/;

/** SHA-256 en hexadecimal del token: lo único que se guarda en la base. */
export const hashDeToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

/** Token nuevo de un solo uso (256 bits de azar). El token en claro solo viaja en el correo; la base guarda su hash. */
export function nuevoToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashDeToken(token) };
}
