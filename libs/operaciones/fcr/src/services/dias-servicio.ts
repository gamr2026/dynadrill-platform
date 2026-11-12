/**
 * Días del servicio (fechas `yyyy-MM-dd` en hora de Ecuador, UTC-5 sin horario de verano). Funciones puras: las usan la bitácora, la finalización
 * de la ejecución y la revisión periódica de requisitos.
 */
const UTC_ECUADOR_MS = 5 * 3_600_000;
const DIA_MS = 86_400_000;
const TOPE_DIAS = 366;

export const aDiaIso = (d: Date) => d.toISOString().slice(0, 10);
const msDeDia = (f: string) => Date.parse(`${f}T00:00:00.000Z`);

/** La fecha de hoy en Ecuador. `ahora`: solo se cambia en pruebas. */
export const hoyEcuador = (ahora: number = Date.now()): string =>
  new Date(ahora - UTC_ECUADOR_MS).toISOString().slice(0, 10);

/** El instante en que empieza ese día en Ecuador (00:00 hora local). */
export const inicioDelDia = (fecha: string): Date => new Date(msDeDia(fecha) + UTC_ECUADOR_MS);

/** Suma (o resta) días a una fecha `yyyy-MM-dd`. */
export const sumarDias = (fecha: string, dias: number): string =>
  new Date(msDeDia(fecha) + dias * DIA_MS).toISOString().slice(0, 10);

/**
 * Los días del servicio desde `inicio` hasta `fin` (inclusive), topados a `hasta` si se indica. Vacío si el rango no existe.
 * Máximo 366 días (un servicio no dura más; evita recorridos desmedidos si una fecha viene mal).
 */
export function diasDelServicio(inicio: Date, fin: Date, hasta?: string): string[] {
  const topeMs = Math.min(fin.getTime(), hasta ? msDeDia(hasta) : fin.getTime());
  const dias: string[] = [];
  for (let ms = inicio.getTime(); ms <= topeMs && dias.length < TOPE_DIAS; ms += DIA_MS)
    dias.push(new Date(ms).toISOString().slice(0, 10));
  return dias;
}

/**
 * Cada día de la bitácora vence al terminar el día siguiente (hora de Ecuador): el día D se debe enviar a más tardar el D+1 a las 23:59:59.
 * Se devuelve como el instante en que empieza el día D+2, que es el primero en el que el día D ya está vencido (`vence_at <= ahora`).
 */
export const venceDelDia = (fecha: string): Date => inicioDelDia(sumarDias(fecha, 2));
