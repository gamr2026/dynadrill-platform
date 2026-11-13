import { ServiceUnavailableException } from '@nestjs/common';

export const TIMEOUT_MS = 10_000;

export type Json = Record<string, unknown>;

export const texto = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v.trim() : null;

/**
 * GET a otro contenedor reenviando el token de quien llama. Un 404 es `null` ("no existe"); cualquier otro fallo es 503 con un mensaje
 * que nombra al módulo: el índice del expediente lo muestra tal cual como motivo de que ese grupo no esté disponible.
 */
export async function consultar<T>(
  base: string,
  ruta: string,
  token: string,
  modulo: string,
): Promise<T | null> {
  let r: Response;
  try {
    r = await fetch(`${base}${ruta}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new ServiceUnavailableException(
      `No se pudo consultar ${modulo}. Intente de nuevo en unos minutos.`,
    );
  }
  if (r.status === 404) return null;
  if (!r.ok) {
    throw new ServiceUnavailableException(
      `${modulo} respondió ${r.status}. Intente de nuevo en unos minutos.`,
    );
  }
  return (await r.json()) as T;
}
