/** Los instantes se guardan en UTC (`timestamptz`); la zona de negocio solo se aplica al presentar. */
export const BUSINESS_TIMEZONE = 'America/Guayaquil';

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function nowUtc(): Date {
  return new Date();
}

/** ISO 8601 en UTC, ej. `2026-10-11T14:03:22.418Z`. */
export function toIsoUtc(date: Date): string {
  return date.toISOString();
}

/** Día calendario (`date` en Postgres) como `YYYY-MM-DD`, tomado en UTC. */
export function toDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** `YYYY-MM-DD` → `Date` a medianoche UTC. Lanza si el formato o el día no existen. */
export function parseDateOnly(value: string): Date {
  const m = DATE_ONLY_RE.exec(value);
  if (!m) throw new RangeError(`Fecha inválida (se esperaba YYYY-MM-DD): ${value}`);
  const [, y, mo, d] = m;
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  if (toDateOnly(date) !== value) throw new RangeError(`La fecha no existe: ${value}`);
  return date;
}

/** Presenta un instante en la zona horaria del negocio (solo para mostrar, nunca para guardar). */
export function formatBusinessTime(date: Date, locale = 'es-EC'): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: BUSINESS_TIMEZONE,
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(date);
}

export function addDaysUtc(date: Date, days: number): Date {
  const copy = new Date(date.getTime());
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}
