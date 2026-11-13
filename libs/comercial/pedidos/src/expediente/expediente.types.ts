/** Origen de un grupo del expediente: de dónde salen sus documentos. */
export type OrigenExpediente =
  | 'facturacion'
  | 'operaciones'
  | 'qhse'
  | 'mantenimiento'
  | 'flota_inspeccion'
  | 'flota_viaje'
  | 'adjuntos';

/** Un documento vigente del pedido (sin anulados, rechazados ni versiones firmadas reemplazadas). */
export interface DocumentoExpediente {
  /** Estable y única dentro del pedido: `${tipo}:${refId}`. */
  clave: string;
  /**
   * `reporte_job`, `reporte_herramientas`, `monitoreo`, `mezcla_quimica`, `reporte_unidad`, `prefactura`, `guia_remision`, `orden_trabajo`,
   * `qhse_<tipo>`, `fcr_<campo>`, `inspeccion_vehiculo`, `gerenciamiento_viaje`, `orden_mantenimiento_general`,
   * `orden_mantenimiento_operativa`, `informe_mantenimiento` o `adjunto`.
   */
  tipo: string;
  titulo: string;
  /** A qué pertenece, en palabras: «Unidad PXB-123 · Orden OM-0012», «Día 2 · 12/11/2026»… */
  pertenece: string;
  /** Día del documento (yyyy-MM-dd). */
  fecha: string | null;
  /** `archivo`: hay un archivo guardado. `formato`: se genera a partir de datos (hoja que dibuja el frontend). */
  fuente: 'archivo' | 'formato';
  archivo: { id: string; nombre: string; mime: string } | null;
  formato: { codigo: string; refId: string } | null;
  /** Todos los documentos admiten una versión firmada. */
  admiteFirmado: boolean;
  firmado: {
    id: string;
    archivoId: string;
    nombre: string;
    subidoPor: string;
    subidoAt: string;
  } | null;
}

export interface GrupoExpediente {
  origen: OrigenExpediente;
  etiqueta: string;
  /** `false` si el módulo de origen no respondió: el grupo trae lo que se pudo leer y el motivo. */
  disponible: boolean;
  motivoNoDisponible: string | null;
  documentos: DocumentoExpediente[];
}

export interface Expediente {
  pedido: {
    id: string;
    codigo: string;
    fechaInicioServicio: string | null;
    fechaFinServicio: string | null;
  };
  grupos: GrupoExpediente[];
}
