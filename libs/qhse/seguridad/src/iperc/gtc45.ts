/**
 * Valoración del riesgo según la GTC 45 (la del formato DYN-SGI-RE-087). Los niveles son los oficiales de la norma:
 * deficiencia (ND) 0/2/6/10, exposición (NE) 1 a 4 y consecuencia (NC) 10/25/60/100. NP = ND×NE y NR = NP×NC se calculan siempre aquí
 * y nunca se guardan (son derivados de los tres enteros, que la base restringe con CHECK).
 */
export const ND_VALORES = [0, 2, 6, 10] as const;
export const NE_VALORES = [1, 2, 3, 4] as const;
export const NC_VALORES = [10, 25, 60, 100] as const;

export interface Valoracion {
  nd: number;
  ne: number;
  nc: number;
}

export type NivelProbabilidad = 'bajo' | 'medio' | 'alto' | 'muy_alto';
export type NivelRiesgo = 'I' | 'II' | 'III' | 'IV';

/** NP = ND × NE. */
export const nivelDeProbabilidad = (v: Pick<Valoracion, 'nd' | 'ne'>): number => v.nd * v.ne;

/** Bandas de la norma: 24–40 muy alto, 10–20 alto, 6–8 medio, hasta 4 bajo. */
export function interpretarProbabilidad(np: number): NivelProbabilidad {
  if (np >= 24) return 'muy_alto';
  if (np >= 10) return 'alto';
  if (np >= 6) return 'medio';
  return 'bajo';
}

/** NR = NP × NC. */
export const nivelDeRiesgo = (v: Valoracion): number => nivelDeProbabilidad(v) * v.nc;

/** Bandas de la norma: I (600–4000, no aceptable), II (150–599), III (40–149, mejorable), IV (< 40, aceptable). */
export function interpretarRiesgo(nr: number): { nivel: NivelRiesgo; aceptabilidad: string } {
  if (nr >= 600) return { nivel: 'I', aceptabilidad: 'No aceptable' };
  if (nr >= 150)
    return { nivel: 'II', aceptabilidad: 'No aceptable o aceptable con control específico' };
  if (nr >= 40) return { nivel: 'III', aceptabilidad: 'Mejorable' };
  return { nivel: 'IV', aceptabilidad: 'Aceptable' };
}

export interface ValoracionCalculada extends Valoracion {
  np: number;
  probabilidad: NivelProbabilidad;
  nr: number;
  nivel: NivelRiesgo;
  aceptabilidad: string;
}

/** La valoración completa con sus derivados; `null` si aún no está evaluada. */
export function valorar(
  nd: number | null,
  ne: number | null,
  nc: number | null,
): ValoracionCalculada | null {
  if (nd === null || ne === null || nc === null) return null;
  const v = { nd, ne, nc };
  const np = nivelDeProbabilidad(v);
  const nr = nivelDeRiesgo(v);
  return { ...v, np, probabilidad: interpretarProbabilidad(np), nr, ...interpretarRiesgo(nr) };
}
