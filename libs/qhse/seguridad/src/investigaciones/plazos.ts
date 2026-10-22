const HORA_MS = 3_600_000;
const DIA_MS = 24 * HORA_MS;

export interface PlazosDelResultado {
  inicioHoras: number;
  preliminarHoras: number | null;
  finalDias: number;
}

export interface EstadoDePlazos {
  /** Límite para asegurar la escena e iniciar la investigación. */
  inicioLimite: Date;
  inicioVencido: boolean;
  /** Límite del informe preliminar; `null` si el resultado no lo exige (Near Miss). */
  preliminarLimite: Date | null;
  finalLimite: Date;
  /** El informe final venció sin que la investigación se haya cerrado. */
  finalVencido: boolean;
}

/**
 * Plazos de HSE-TRIAGE-002 contados desde el momento del incidente. No se guardan: salen del catálogo de resultados, así que un ajuste del
 * catálogo se refleja en todas las investigaciones abiertas. El inicio se mide contra el momento en que se aseguró la escena (o contra ahora si
 * aún no se aseguró).
 */
export function calcularPlazos(
  fechaIncidente: Date,
  plazos: PlazosDelResultado,
  escenaAseguradaAt: Date | null,
  cerrada: boolean,
  ahora: Date = new Date(),
): EstadoDePlazos {
  const t0 = fechaIncidente.getTime();
  const inicioLimite = new Date(t0 + plazos.inicioHoras * HORA_MS);
  const finalLimite = new Date(t0 + plazos.finalDias * DIA_MS);
  return {
    inicioLimite,
    inicioVencido: (escenaAseguradaAt ?? ahora).getTime() > inicioLimite.getTime(),
    preliminarLimite:
      plazos.preliminarHoras === null ? null : new Date(t0 + plazos.preliminarHoras * HORA_MS),
    finalLimite,
    finalVencido: !cerrada && ahora.getTime() > finalLimite.getTime(),
  };
}

/** Consecutivo visible de la investigación: INV-000001. */
export const codigoInvestigacion = (numero: number): string =>
  `INV-${String(numero).padStart(6, '0')}`;
