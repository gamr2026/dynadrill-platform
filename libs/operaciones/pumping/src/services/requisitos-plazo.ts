import type { EstadoRequisito } from '../generated/client';

/** Lo que necesita una fila de requisito del ticket para decir cómo va su plazo y si fue exonerada. */
export interface FilaConPlazo {
  estado: EstadoRequisito;
  venceAt: Date | null;
  vencidoAt: Date | null;
  exoneradoAt: Date | null;
  exoneradoPor: string | null;
  motivo: string | null;
}

/**
 * Los campos de plazo y de exoneración que toda pantalla recibe junto con el estado de un requisito. `vencido`: está pendiente y ya pasó su
 * plazo (se calcula al leer, aunque la revisión periódica todavía no lo haya marcado); `vencidoAt` es cuándo lo marcó la revisión y se conserva
 * al cumplirse (un requisito cumplido con `vencidoAt` se cumplió tarde).
 */
export function plazoDeRequisito(
  f: FilaConPlazo,
  rolResponsable: string | null,
  ahora: Date = new Date(),
) {
  return {
    venceAt: f.venceAt,
    vencidoAt: f.vencidoAt,
    vencido:
      f.estado === 'pendiente' && f.venceAt !== null && f.venceAt.getTime() < ahora.getTime(),
    rolResponsable,
    exonerado: f.estado === 'exonerado',
    exoneradoAt: f.exoneradoAt,
    exoneradoPor: f.exoneradoPor,
    motivoExoneracion: f.estado === 'exonerado' ? f.motivo : null,
  };
}
