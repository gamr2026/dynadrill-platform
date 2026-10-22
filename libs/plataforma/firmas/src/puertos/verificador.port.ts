import type { AuthUser } from '@dyn/common';

export interface LecturaDeFirma {
  resultado: 'firma_detectada' | 'firma_no_detectada' | 'no_concluyente';
  /** 0 a 1; no es una probabilidad calibrada. */
  confianza: number;
  /** `null` si no se pidió comparar el nombre. */
  nombreCoincide: boolean | null;
}

/**
 * Lee un archivo firmado en busca de la firma manuscrita. Lo aporta el contenedor (`archivos` es dueño del servicio de lectura):
 * `firmas` no conoce a `archivos` más allá de la FK de la firma al archivo.
 */
export abstract class VerificadorFirmaPort {
  /** Es una ayuda para revisar, no certifica la autenticidad. `nombreEsperado` es el de quien firmó. */
  abstract leer(
    archivoId: string,
    nombreEsperado: string,
    actor: AuthUser,
  ): Promise<LecturaDeFirma>;
}
