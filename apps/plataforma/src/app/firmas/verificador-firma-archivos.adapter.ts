import { Injectable } from '@nestjs/common';
import { ArchivosService } from '@dyn/archivos';
import type { AuthUser } from '@dyn/common';
import { LecturaDeFirma, VerificadorFirmaPort } from '@dyn/firmas';

/** Leer la firma de un archivo es del servicio de `archivos` (el que tiene el contenido y el lector de firmas). */
@Injectable()
export class VerificadorFirmaArchivosAdapter extends VerificadorFirmaPort {
  constructor(private readonly archivos: ArchivosService) {
    super();
  }

  async leer(archivoId: string, nombreEsperado: string, actor: AuthUser): Promise<LecturaDeFirma> {
    const v = await this.archivos.verificarFirma(archivoId, { nombreEsperado }, actor);
    return {
      resultado: v.resultado === 'no_detectada' ? 'firma_no_detectada' : v.resultado,
      confianza: v.confianza,
      nombreCoincide: v.nombreCoincide,
    };
  }
}
