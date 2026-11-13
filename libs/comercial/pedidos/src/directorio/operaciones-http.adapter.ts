import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { consultar, type Json, texto, TIMEOUT_MS } from './consulta-http';
import {
  DocumentoFcrRef,
  DocumentoTicketPumpingRef,
  GerenciamientoViajeRef,
  InspeccionVehiculoRef,
  OperacionesPort,
  OrdenMantenimientoRef,
  ReporteUnidadRef,
} from './operaciones.port';

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
      archivoId: texto(d['archivoId']),
    }));
  }

  async documentosDeTicketFcr(ticketId: string, token: string): Promise<DocumentoFcrRef[]> {
    const lista = await this.lista(
      `/api/operaciones/fcr/tickets/${ticketId}/documentos`,
      token,
      'FCR',
    );
    return lista.map((d) => ({
      id: String(d['id']),
      campo: String(d['campo']),
      archivoId: texto(d['archivoId']),
    }));
  }

  async reportesDeUnidadDeTicket(ticketId: string, token: string): Promise<ReporteUnidadRef[]> {
    const lista = await this.lista(
      `/api/operaciones/pumping/tickets/${ticketId}/expediente/reportes-unidad`,
      token,
      'Pumping',
    );
    return lista.map((d) => ({
      id: String(d['id']),
      fecha: String(d['fecha']),
      unidad: texto(d['placa']) ?? texto(d['unidadCodigo']) ?? texto(d['unidadNombre']) ?? '—',
    }));
  }

  async inspeccionesDeTicket(ticketId: string, token: string): Promise<InspeccionVehiculoRef[]> {
    const lista = await this.lista(
      `/api/operaciones/flota/inspecciones-vehiculo?ticketId=${ticketId}`,
      token,
      'Flota',
    );
    return lista.map((d) => ({
      id: String(d['id']),
      fecha: texto(d['fecha']),
      unidad: this.unidad(d['unidad']),
      momento: texto(d['momento']),
      anulada: d['estado'] === 'anulada',
    }));
  }

  async viajesDeTicket(ticketId: string, token: string): Promise<GerenciamientoViajeRef[]> {
    const lista = await this.lista(
      `/api/operaciones/flota/gerenciamientos-viaje?ticketId=${ticketId}`,
      token,
      'Flota',
    );
    return lista.map((d) => ({
      id: String(d['id']),
      codigo: texto(d['codigo']),
      tipo: texto(d['tipo']),
      fecha: texto(d['fecha']),
      unidad: this.unidad(d['unidad']),
      estado: String(d['estado'] ?? 'pendiente'),
    }));
  }

  async ordenesMantenimientoDelServicio(
    ticketId: string,
    token: string,
  ): Promise<OrdenMantenimientoRef[]> {
    const lista = await this.lista(
      `/api/operaciones/mantenimiento/tickets/${ticketId}/ordenes-del-servicio`,
      token,
      'Mantenimiento',
    );
    return lista.map((d) => ({
      id: String(d['id']),
      codigo: String(d['codigo']),
      unidad: this.unidad(d['unidad']),
      tiposSuborden: ((d['subordenes'] as Json[] | undefined) ?? []).map((s) =>
        String((s['tipo'] as Json | undefined)?.['codigo'] ?? ''),
      ),
      creadaAt: texto(d['creadaAt']),
    }));
  }

  /** `{ codigo, nombre, placa? }` de una unidad: la placa si la hay, si no el código. */
  private unidad(u: unknown): string {
    const o = (u ?? {}) as Json;
    return texto(o['placa']) ?? texto(o['codigo']) ?? texto(o['nombre']) ?? '—';
  }

  /** Una lista que devuelve Operaciones; un 404 (el ticket ya no existe) es una lista vacía. */
  private async lista(ruta: string, token: string, modulo: string): Promise<Json[]> {
    return (await consultar<Json[]>(this.base, ruta, token, modulo)) ?? [];
  }
}
