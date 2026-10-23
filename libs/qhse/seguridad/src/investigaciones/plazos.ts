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

/** Día (AAAA-MM-DD, hora de Ecuador) de un momento: así se muestran los plazos en los avisos. */
export const diaEcuador = (d: Date): string =>
  d.toLocaleDateString('en-CA', { timeZone: 'America/Guayaquil' });

/** Fechas límite de inicio y del informe final de una investigación, ya como día, para el texto de los avisos. */
export function limitesParaAviso(
  fechaIncidente: Date,
  plazos: PlazosDelResultado,
): { inicioLimite: string; finalLimite: string } {
  const p = calcularPlazos(fechaIncidente, plazos, null, false);
  return { inicioLimite: diaEcuador(p.inicioLimite), finalLimite: diaEcuador(p.finalLimite) };
}

/** Consecutivo visible de la investigación: INV-000001. */
export const codigoInvestigacion = (numero: number): string =>
  `INV-${String(numero).padStart(6, '0')}`;
