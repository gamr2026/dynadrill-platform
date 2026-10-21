import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** Resultado de la lectura automática de una firma (ayuda para revisar; no certifica la autenticidad). */
export interface LecturaFirma {
  resultado: 'firma_detectada' | 'no_detectada' | 'no_concluyente';
  confianza: number;
}

/** Lee la firma de un archivo ya subido. `null` = el servicio no respondió (la lectura nunca interrumpe la carga). */
export abstract class VerificadorFirmas {
  abstract verificar(archivoId: string, token: string): Promise<LecturaFirma | null>;
}

/** La lectura de una firma puede tardar (hasta unos 20 s en documentos de varias páginas). */
const TIMEOUT_MS = 90_000;

/** Pide la lectura al servicio de archivos de plataforma (`PLATAFORMA_URL`) con el token de quien carga el documento. */
@Injectable()
export class VerificadorFirmasHttp extends VerificadorFirmas {
  private readonly base: string;

  constructor(cfg: ConfigService) {
    super();
    this.base = (cfg.get<string>('PLATAFORMA_URL') ?? 'http://localhost:3101').replace(/\/+$/, '');
  }

  async verificar(archivoId: string, token: string): Promise<LecturaFirma | null> {
    try {
      const r = await fetch(`${this.base}/api/archivos/${archivoId}/verificar-firma`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: '{}',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!r.ok) return null;
      const j = (await r.json()) as Record<string, unknown>;
      return {
        resultado: j['resultado'] as LecturaFirma['resultado'],
        confianza: Number(j['confianza']),
      };
    } catch {
      return null;
    }
  }
}
