/** Documento por pedido de QHSE (formato de recepción, ART, PT, SFI o Acta de Entrega de Locación), ya vigente. */
export interface DocumentoQhseRef {
  id: string;
  /** `formato_recepcion`, `art`, `pt`, `sfi` o `formato_entrega` (el Acta). */
  tipo: string;
  archivoId: string;
  referencia: string | null;
  /** ART: emisión. PT: día de operación (yyyy-MM-dd). */
  fecha: string | null;
}

/**
 * Lo que Comercial necesita de QHSE: sus documentos del pedido (los vigentes: sin anular ni rechazar). Se consulta por la API de QHSE
 * reenviando el token de quien llama. Lanza 503 (`ServiceUnavailableException`) si QHSE no responde.
 */
export abstract class QhsePort {
  abstract documentosDelPedido(pedidoId: string, token: string): Promise<DocumentoQhseRef[]>;
}
