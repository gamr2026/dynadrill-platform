import { createHash, timingSafeEqual } from 'node:crypto';

/** SHA-256 en hexadecimal (64 caracteres), el formato de `char(64)` del modelo de datos. */
export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Comparación en tiempo constante de dos hashes hexadecimales. */
export function safeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}
