/** Documento que Pumping guarda en un ticket (mezcla de químicos o monitoreo de un día). */
export interface DocumentoTicketPumpingRef {
  id: string;
  tipo: 'mezcla_quimica' | 'monitoreo';
  /** Día del monitoreo (yyyy-MM-dd); nulo en la mezcla. */
  fecha: string | null;
  /** Archivo guardado en `archivos` (si la respuesta lo trae). */
  archivoId?: string | null;
}

/** Documento de un ticket de FCR: uno de los seis campos documentales, con su archivo. */
export interface DocumentoFcrRef {
  id: string;
  campo: string;
  archivoId: string | null;
}

/** Reporte de unidad de Pumping (uno por unidad y día del servicio). */
export interface ReporteUnidadRef {
  id: string;
  /** Día del reporte (yyyy-MM-dd). */
  fecha: string;
  /** Cómo se nombra la unidad en pantalla: la placa o, si no tiene, el código. */
  unidad: string;
}

/** Inspección de vehículo de una unidad del ticket (vigente: no anulada). */
export interface InspeccionVehiculoRef {
  id: string;
  /** Instante de la inspección (ISO 8601). */
  fecha: string | null;
  unidad: string;
  momento: string | null;
  anulada: boolean;
}

/** Gerenciamiento de viaje de una unidad del ticket. */
export interface GerenciamientoViajeRef {
  id: string;
  codigo: string | null;
  tipo: string | null;
  /** Día del viaje (yyyy-MM-dd). */
  fecha: string | null;
  unidad: string;
  /** `pendiente`, `autorizado` o `rechazado`. */
  estado: string;
}

/** Orden de mantenimiento nacida de un reporte de unidad del ticket. */
export interface OrdenMantenimientoRef {
  id: string;
  codigo: string;
  unidad: string;
  /** Códigos de tipo de las sub-órdenes (`mecanico`, `instrumental`, `operativo`…): deciden qué hojas existen. */
  tiposSuborden: string[];
  /** Instante en que se abrió la orden (ISO 8601). */
  creadaAt: string | null;
}

/**
 * Lo que Comercial necesita saber de Operaciones y no recibe por eventos. Los contenedores no comparten tablas, así que se
 * consulta por la API de Operaciones reenviando el token de quien llama (que ya tiene el permiso de ver esos documentos).
 * Todas las consultas del expediente lanzan 503 (`ServiceUnavailableException`) si el contenedor no responde.
 */
export abstract class OperacionesPort {
  /** Los documentos del ticket de Pumping, o `null` si el ticket no existe. */
  abstract documentosDeTicketPumping(
    ticketId: string,
    token: string,
  ): Promise<DocumentoTicketPumpingRef[] | null>;
  /** Los documentos de un ticket de FCR. */
  abstract documentosDeTicketFcr(ticketId: string, token: string): Promise<DocumentoFcrRef[]>;
  /** Los reportes de unidad (uno por unidad y día) de un ticket de Pumping. */
  abstract reportesDeUnidadDeTicket(ticketId: string, token: string): Promise<ReporteUnidadRef[]>;
  /** Las inspecciones de vehículo de las unidades de un ticket de Pumping. */
  abstract inspeccionesDeTicket(ticketId: string, token: string): Promise<InspeccionVehiculoRef[]>;
  /** Los gerenciamientos de viaje de un ticket de Pumping. */
  abstract viajesDeTicket(ticketId: string, token: string): Promise<GerenciamientoViajeRef[]>;
  /** Las órdenes de mantenimiento que nacieron de los reportes de unidad de este ticket. */
  abstract ordenesMantenimientoDelServicio(
    ticketId: string,
    token: string,
  ): Promise<OrdenMantenimientoRef[]>;
}
