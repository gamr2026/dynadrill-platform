import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { consultar, type Json, texto } from './consulta-http';
import { DocumentoQhseRef, QhsePort } from './qhse.port';

/**
 * Adaptador HTTP hacia el contenedor de QHSE (`QHSE_URL`, por defecto el puerto local 3104). Reenvía el token de quien llama. El
 * listado de QHSE ya omite los documentos anulados; los rechazados se descartan aquí (un rechazado también figura como anulado).
 */
@Injectable()
export class QhseHttpAdapter extends QhsePort {
  private readonly base: string;

  constructor(cfg: ConfigService) {
    super();
    this.base = (cfg.get<string>('QHSE_URL') ?? 'http://localhost:3104').replace(/\/+$/, '');
  }

  async documentosDelPedido(pedidoId: string, token: string): Promise<DocumentoQhseRef[]> {
    const lista =
      (await consultar<Json[]>(
        this.base,
        `/api/qhse/documentos?pedidoId=${pedidoId}`,
        token,
        'QHSE',
      )) ?? [];
    return lista
      .filter((d) => d['anulado'] !== true && d['revisionEstado'] !== 'rechazado')
      .map((d) => ({
        id: String(d['id']),
        tipo: String(d['tipo']),
        archivoId: String(d['archivoId']),
        referencia: texto(d['referencia']),
        fecha: texto(d['fecha']),
      }));
  }
}
