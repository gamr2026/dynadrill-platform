import { sha256Hex } from './hash';

/** Datos que el contrato 4.14 pide en un evento `*.firmado` firmado «de una línea». */
export type FirmaDeUnaLinea = {
  documentoTipo: string;
  documentoId: string;
  rolFirmante: string;
  metodo: 'linea';
  hashDocumento: string;
};

/**
 * Arma la prueba de una firma «de una línea»: el SHA-256 (hexadecimal minúscula) del texto que se firma, que identifica el documento, el
 * papel, quién firma y cuándo. Los módulos la mandan en el evento `<contenedor>.<documento>.firmado`; Firmas la registra como evidencia.
 */
export function firmaDeUnaLinea(
  documentoTipo: string,
  documentoId: string,
  rolFirmante: string,
  firmanteId: string,
  firmadaAt: Date,
  ...detalle: string[]
): FirmaDeUnaLinea {
  const texto = [documentoTipo, documentoId, rolFirmante, firmanteId, firmadaAt.toISOString(), ...detalle].join('|');
  return { documentoTipo, documentoId, rolFirmante, metodo: 'linea', hashDocumento: sha256Hex(texto) };
}
