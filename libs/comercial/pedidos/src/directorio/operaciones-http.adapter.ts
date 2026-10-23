import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentoTicketPumpingRef, OperacionesPort } from './operaciones.port';

const TIMEOUT_MS = 10_000;

/**
 * Adaptador HTTP hacia el contenedor de operaciones (`OPERACIONES_URL`, por defecto el puerto local 3103). Reenvía el token de quien
 * llama. Un 404 es "no existe" (null); cualquier otro fallo es 503 con un mensaje claro: no se acepta nada a ciegas.
 */
@Injectable()
export class OperacionesHttpAdapter extends OperacionesPort {
  private readonly base: string;

  constructor(cfg: ConfigService) {
    super();
    this.base = (cfg.get<string>('OPERACIONES_URL') ?? 'http://localhost:3103').replace(/\/+$/, '');
  }

  async documentosDeTicketPumping(
    ticketId: string,
    token: string,
  ): Promise<DocumentoTicketPumpingRef[] | null> {
    let r: Response;
    try {
      r = await fetch(`${this.base}/api/operaciones/pumping/tickets/${ticketId}/documentos`, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new ServiceUnavailableException(
        'No se pudo consultar los documentos del ticket en Pumping. Intente de nuevo en unos minutos.',
      );
    }
    if (r.status === 404) return null;
    if (!r.ok) {
      throw new ServiceUnavailableException(
        `Pumping respondió ${r.status} al consultar los documentos del ticket. Intente de nuevo en unos minutos.`,
      );
    }
    const lista = (await r.json()) as Array<Record<string, unknown>>;
    return lista.map((d) => ({
      id: String(d['id']),
      tipo: d['tipo'] as DocumentoTicketPumpingRef['tipo'],
      fecha: typeof d['fecha'] === 'string' ? d['fecha'] : null,
    }));
  }
}
