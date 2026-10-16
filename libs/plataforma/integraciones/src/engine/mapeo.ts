export type Transformacion =
  'texto' | 'entero' | 'numero' | 'booleano' | 'fecha_ms_ec' | 'fecha_iso';

export const TRANSFORMACIONES: readonly Transformacion[] = [
  'texto',
  'entero',
  'numero',
  'booleano',
  'fecha_ms_ec',
  'fecha_iso',
];

export interface MapeoDef {
  destino: string;
  origen: string;
  transformacion: string | null;
  obligatorio: boolean;
}

const ECUADOR_UTC_MS = -5 * 3_600_000; // América/Guayaquil no usa horario de verano

/** Lee una ruta con puntos (`empresa.identificacion`) dentro de un objeto; `undefined` si algún tramo falta. */
export function leerRuta(obj: unknown, ruta: string): unknown {
  if (ruta === '') return obj;
  let actual: unknown = obj;
  for (const tramo of ruta.split('.')) {
    if (actual === null || typeof actual !== 'object') return undefined;
    actual = (actual as Record<string, unknown>)[tramo];
  }
  return actual;
}

/** Aplica una transformación. Vacío o ausente → null (nunca lanza: un dato raro no debe tumbar la corrida). */
export function transformar(valor: unknown, transformacion: string | null): unknown {
  if (valor === undefined || valor === null) return null;
  switch (transformacion) {
    case null:
    case '':
      return valor;
    case 'texto': {
      if (typeof valor !== 'string' && typeof valor !== 'number' && typeof valor !== 'boolean') {
        return null;
      }
      const t = String(valor).trim();
      return t === '' ? null : t;
    }
    case 'entero': {
      const n = Number(valor);
      return Number.isInteger(n) ? n : null;
    }
    case 'numero': {
      const n = Number(valor);
      return Number.isFinite(n) ? n : null;
    }
    case 'booleano':
      if (typeof valor === 'boolean') return valor;
      if (valor === 'true' || valor === 1) return true;
      if (valor === 'false' || valor === 0) return false;
      return null;
    case 'fecha_ms_ec': {
      if (typeof valor !== 'number' || !Number.isFinite(valor)) return null;
      const local = new Date(valor + ECUADOR_UTC_MS);
      return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()));
    }
    case 'fecha_iso': {
      if (typeof valor !== 'string') return null;
      const d = new Date(valor);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    default:
      return null;
  }
}

/**
 * Traduce una fila de la respuesta a nuestro modelo. Devuelve `null` si falta un campo obligatorio
 * (la fila se omite y se cuenta como omitida).
 */
export function aplicarMapeo(
  fila: unknown,
  mapeos: readonly MapeoDef[],
): Record<string, unknown> | null {
  const salida: Record<string, unknown> = {};
  for (const m of mapeos) {
    const v = transformar(leerRuta(fila, m.origen), m.transformacion);
    if (m.obligatorio && v === null) return null;
    salida[m.destino] = v;
  }
  return salida;
}
