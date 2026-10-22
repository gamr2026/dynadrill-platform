const DIA_MS = 86_400_000;

/** Hoy en Ecuador (AAAA-MM-DD): las vigencias y los plazos se cuentan por día de calendario local. */
export const hoyEcuador = (): string =>
  new Date().toLocaleDateString('en-CA', { timeZone: 'America/Guayaquil' });

/** Fecha de medianoche UTC de un día AAAA-MM-DD (así la guarda y la lee Prisma en columnas `date`). */
export const aFecha = (dia: string): Date => new Date(`${dia}T00:00:00.000Z`);

/** AAAA-MM-DD de una columna `date`. */
export const aDia = (d: Date): string => d.toISOString().slice(0, 10);

/** `fecha + INTERVAL 'n months'` como lo hace PostgreSQL: si el día no existe en el mes final, queda el último día de ese mes. */
export function masMeses(dia: string, meses: number): string {
  const [a, m, d] = dia.split('-').map(Number);
  const f = new Date(Date.UTC(a, m - 1 + meses, d));
  if (f.getUTCDate() !== d) f.setUTCDate(0);
  return f.toISOString().slice(0, 10);
}

/** Días que faltan para una fecha (negativo si ya pasó), por día de calendario. */
export function diasHasta(fecha: string, desde: string = hoyEcuador()): number {
  return Math.round((Date.parse(`${fecha}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) / DIA_MS);
}

/** `fecha + n días` (AAAA-MM-DD). */
export function masDias(dia: string, dias: number): string {
  return new Date(Date.parse(`${dia}T00:00:00Z`) + dias * DIA_MS).toISOString().slice(0, 10);
}
