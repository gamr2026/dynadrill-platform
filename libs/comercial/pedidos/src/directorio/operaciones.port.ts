/** Documento que Pumping guarda en un ticket (mezcla de químicos o monitoreo de un día). */
export interface DocumentoTicketPumpingRef {
  id: string;
  tipo: 'mezcla_quimica' | 'monitoreo';
  /** Día del monitoreo (yyyy-MM-dd); nulo en la mezcla. */
  fecha: string | null;
}

/**
 * Lo que Comercial necesita saber de Operaciones y no recibe por eventos. Los contenedores no comparten tablas, así que se
 * consulta por la API de Operaciones reenviando el token de quien llama (que ya tiene el permiso de ver esos documentos).
 */
export abstract class OperacionesPort {
  /** Los documentos del ticket de Pumping, o `null` si el ticket no existe. */
  abstract documentosDeTicketPumping(
    ticketId: string,
    token: string,
  ): Promise<DocumentoTicketPumpingRef[] | null>;
}
