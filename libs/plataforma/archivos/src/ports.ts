import type { Readable } from 'node:stream';

/**
 * Almacenamiento de objetos. Hoy Azure Blob (Azurite en local); cambiar de proveedor es escribir otro adaptador.
 * El contenido nunca pasa por la base de datos.
 */
export abstract class FileStoragePort {
  abstract guardar(clave: string, contenido: Buffer, mimeType: string): Promise<void>;
  abstract leer(clave: string): Promise<Readable>;
  abstract borrar(clave: string): Promise<void>;
}

export interface ResultadoEscaneo {
  /** `true` si no se encontró malware. */
  limpio: boolean;
  /** Nombre de la amenaza, si la hubo. */
  amenaza?: string;
  /** `omitido` cuando no hay antivirus configurado (solo desarrollo). */
  omitido?: boolean;
}

/** Análisis antimalware del contenido antes de guardarlo (Defender for Storage en Azure; ClamAV en local). */
export abstract class ScannerPort {
  abstract escanear(contenido: Buffer): Promise<ResultadoEscaneo>;
}

export interface ParametrosVerificacion {
  /** Nombre y cargo que se espera ver junto a la firma (opcionales). */
  nombreEsperado?: string;
  cargoEsperado?: string;
}

export type ResultadoFirma = 'firma_detectada' | 'no_detectada' | 'no_concluyente';

export interface VerificacionFirma {
  resultado: ResultadoFirma;
  /** Confianza en el resultado (0 a 1); no es una probabilidad calibrada. */
  confianza: number;
  /** `null` si no se pidió comparar el nombre. */
  nombreCoincide: boolean | null;
  /** Hay un sello de firma electrónica (el servicio no la valida). */
  firmaElectronica: boolean;
  observaciones: string[];
  paginasAnalizadas: number;
  duracionMs: number;
}

export type EstadoFirmasElectronicas =
  | 'sin_firmas_digitales'
  | 'verificado'
  | 'verificado_con_advertencias'
  | 'firmantes_no_verificados'
  | 'alterado';

export type EstadoIntegridad =
  | 'intacto'
  | 'intacto_con_revisiones_posteriores'
  | 'modificado_despues_de_firmar'
  | 'firma_invalida';

export type OrigenFechaFirma = 'sello_de_tiempo' | 'declarada_por_el_firmante' | 'desconocida';

/** Una firma digital incrustada en el PDF (PAdES / PKCS#7), ya validada por el servicio. */
export interface FirmaDigitalVerificada {
  campo: string;
  integridad: EstadoIntegridad;
  /** La firma criptográfica es correcta. */
  firmaValida: boolean;
  documentoIntacto: boolean;
  firmanteNombre: string | null;
  firmanteIdentificacion: string | null;
  firmanteCorreo: string | null;
  emisor: string | null;
  fechaFirma: string | null;
  origenFecha: OrigenFechaFirma;
  vigenteAlFirmar: boolean | null;
  cadenaReconocida: boolean;
  /** Raíz de confianza a la que llega la cadena. */
  entidad: string | null;
  firmanteVerificado: boolean;
  conclusion: string;
  advertencias: string[];
}

export interface VerificacionFirmaElectronica {
  estado: EstadoFirmasElectronicas;
  resumen: string;
  firmas: FirmaDigitalVerificada[];
  /** El servicio no consulta la revocación del certificado (OCSP/CRL). */
  revocacion: 'no_verificada';
  duracionMs: number;
}

/**
 * Lectura de firmas de un documento (OCR + visión). Es una AYUDA para revisar: nunca certifica que la firma sea
 * auténtica. Hoy lo atiende el servicio `apps/firmas-ocr`; cambiar de proveedor es escribir otro adaptador.
 */
export abstract class FirmaVerificadorPort {
  /** `false` si no hay servicio configurado. */
  abstract disponible(): boolean;
  abstract verificar(
    contenido: Buffer,
    nombre: string,
    mimeType: string,
    parametros: ParametrosVerificacion,
  ): Promise<VerificacionFirma>;
  /**
   * Valida las firmas digitales incrustadas en un PDF (integridad, vigencia y cadena de confianza). A diferencia de la
   * lectura de firmas manuscritas, esta SÍ es una validación criptográfica; aun así, sin revocación y con las raíces
   * cargadas en el servicio, un firmante puede salir "no verificado".
   */
  abstract verificarFirmaElectronica(
    contenido: Buffer,
    nombre: string,
  ): Promise<VerificacionFirmaElectronica>;
}
