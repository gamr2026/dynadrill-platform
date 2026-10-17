import type { Prisma } from '../generated/client';

/** Cliente de una transacción de Prisma. */
export type Tx = Prisma.TransactionClient;

/** Lo que se registra por cada elemento entregado. El elemento y la talla salen de catálogos (nunca texto suelto). */
export interface RenglonEntrada {
  elementoId: string;
  cantidad: number;
  tallaId?: string | null;
  recibioCapacitacion: boolean;
  observaciones?: string | null;
  /** AAAA-MM-DD; si no viene, hoy. */
  entregadoEl?: string | null;
}

/** Consecutivo visible de la entrega: EPI-000001. */
export const codigoDe = (numero: number): string => `EPI-${String(numero).padStart(6, '0')}`;

/** Texto recortado; vacío = `null`. */
export const texto = (s: string | null | undefined): string | null => {
  const t = s?.trim();
  return t ? t : null;
};
