export const MIN_PORQUES = 5;

export interface DatosParaRevision {
  porques: number;
  conclusion: string | null;
  /** Acciones que no están canceladas. */
  accionesVigentes: number;
}

export interface DatosParaCierre {
  notificacionLegalRequerida: boolean;
  ministerioTrabajoNotificadoAt: Date | null;
  iessNotificadoAt: Date | null;
}

/** Lo que falta para enviar la investigación a revisión (la base lo exige también; aquí se explica con claridad). */
export function faltaParaRevision(d: DatosParaRevision): string[] {
  const falta: string[] = [];
  if (d.porques < MIN_PORQUES)
    falta.push(`Complete al menos ${MIN_PORQUES} niveles de los 5 Porqués (tiene ${d.porques})`);
  if (!d.conclusion) falta.push('Indique la conclusión: incidente o accidente');
  if (d.accionesVigentes < 1) falta.push('Registre al menos una acción correctiva o preventiva');
  return falta;
}

/** Lo que falta para cerrar la investigación: si la notificación legal es obligatoria, las dos fechas. */
export function faltaParaCierre(d: DatosParaCierre): string[] {
  const falta: string[] = [];
  if (d.notificacionLegalRequerida) {
    if (!d.ministerioTrabajoNotificadoAt)
      falta.push('Registre cuándo se notificó al Ministerio del Trabajo');
    if (!d.iessNotificadoAt) falta.push('Registre cuándo se notificó al IESS');
  }
  return falta;
}
