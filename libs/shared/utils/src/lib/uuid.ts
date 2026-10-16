import { randomBytes, randomInt } from 'node:crypto';

let lastMs = -1;
let seq = 0;

/**
 * UUIDv7 (RFC 9562): 48 bits de milisegundos Unix + 12 bits de secuencia + 62 bits aleatorios.
 * Ordenable por tiempo, así que sirve como PK sin fragmentar el índice B-tree. Lo genera la
 * aplicación (documento de BD, cap. 3.2); es monotónico dentro del proceso.
 */
export function uuidv7(): string {
  let ms = Date.now();
  if (ms > lastMs) {
    lastMs = ms;
    seq = randomInt(0, 0x800); // deja margen de 0x800 incrementos dentro del mismo milisegundo
  } else {
    seq += 1;
    if (seq > 0xfff) {
      lastMs += 1;
      seq = randomInt(0, 0x800);
    }
    ms = lastMs;
  }

  const bytes = Buffer.alloc(16);
  bytes.writeUIntBE(ms, 0, 6);
  bytes[6] = 0x70 | (seq >> 8);
  bytes[7] = seq & 0xff;
  const rand = randomBytes(8);
  bytes[8] = 0x80 | (rand[0] & 0x3f);
  rand.copy(bytes, 9, 1, 8);

  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** Milisegundos Unix embebidos en un UUIDv7 (útil para depurar orden). */
export function uuidv7Timestamp(id: string): number {
  return parseInt(id.replace(/-/g, '').slice(0, 12), 16);
}
