/**
 * Arma el código de un documento a partir de su secuencia, como lo hace AS2: prefijo + número con ceros a la izquierda
 * + sufijo, y `longitud` es el largo TOTAL (incluye prefijo y sufijo). Ej.: prefijo `PEC-`, longitud 10, número 4675 →
 * `PEC-004675`. Con `longitud` 0 no hay relleno: `4317` → `4317`.
 * Lanza un error si el código no cabe en la longitud (no se emiten códigos más largos que lo permitido).
 */
export function formatearCodigo(
  prefijo: string | null,
  sufijo: string | null,
  longitud: number,
  numero: number,
): string {
  const pre = prefijo ?? '';
  const suf = sufijo ?? '';
  const digitos = String(numero);
  if (longitud === 0) return `${pre}${digitos}${suf}`;

  const ancho = longitud - pre.length - suf.length;
  if (ancho < 1 || digitos.length > ancho) {
    throw new Error(
      `El número ${numero} no cabe en un código de longitud ${longitud} (prefijo "${pre}", sufijo "${suf}")`,
    );
  }
  return `${pre}${digitos.padStart(ancho, '0')}${suf}`;
}
