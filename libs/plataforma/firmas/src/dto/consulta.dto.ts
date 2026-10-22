import { IsUUID, Matches } from 'class-validator';
import type { MetodoFirma, ResultadoVerificacionFirma } from '../generated/client';

/** Las firmas de un documento: ambos datos son obligatorios (no hay listado general). */
export class FirmasDeDocumentoQueryDto {
  @Matches(/^[a-z][a-z0-9_]*$/, { message: 'documentoTipo no tiene un formato válido' })
  documentoTipo!: string;

  @IsUUID(undefined, { message: 'documentoId debe ser un UUID' })
  documentoId!: string;
}

export interface VerificacionResponse {
  id: string;
  resultado: ResultadoVerificacionFirma;
  confianza: number;
  nombreCoincide: boolean | null;
  verificadaAt: string;
  solicitadaPor: { id: string; nombre: string };
}

export interface FirmaResponse {
  id: string;
  rolFirmante: { codigo: string; descripcion: string };
  firmante: { id: string; nombre: string };
  firmadaAt: string;
  metodo: MetodoFirma;
  /** La más reciente del documento para ese papel; las anteriores son historia. */
  vigente: boolean;
  /** Solo en la firma «de una línea». */
  hashDocumento: string | null;
  /** Solo en las firmas con archivo; la huella es la del archivo. */
  archivo: { id: string; nombre: string; sha256: string } | null;
  /** Último intento de lectura de la firma del archivo (nulo si nunca se verificó). */
  verificacion: VerificacionResponse | null;
}

export interface FirmasDeDocumentoResponse {
  documentoTipo: string;
  documentoId: string;
  firmas: FirmaResponse[];
}
