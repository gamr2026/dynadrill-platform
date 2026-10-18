/**
 * Código de artículo sin espacios (el alta de artículos no los admite): se pegan alrededor de «-» y «/» y los demás pasan a «-».
 * Ejemplos: `DYFE - 100` → `DYFE-100`, `CT-MCR/ CT95706 9/5` → `CT-MCR/CT95706-9/5`.
 */
export const normalizarCodigo = (codigo: string): string =>
  codigo
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s*([-/])\s*/g, '$1')
    .replace(/\s+/g, '-');

/** ¿El código tiene espacios (y por tanto hay que normalizarlo)? */
export const tieneEspacios = (codigo: string): boolean => /\s/.test(codigo);
