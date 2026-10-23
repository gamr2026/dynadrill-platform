import { uuidv7 } from '@dyn/utils';
import type { PrismaClient } from '../generated/client';

/** Frecuencias de seguimiento de un plan de acción o de un aspecto ambiental. QHSE las amplía; el comportamiento nunca depende del nombre. */
export const FRECUENCIAS_SEGUIMIENTO = [
  ['mensual', 'Mensual'],
  ['trimestral', 'Trimestral'],
  ['semestral', 'Semestral'],
  ['anual', 'Anual'],
] as const;

/**
 * Etapas del ciclo de vida de un aspecto ambiental (ISO 14001). Valores iniciales de referencia: el formato «MATRIZ DE ASPECTOS AMBIENTALES Rev00» no
 * está en la documentación, así que QHSE los ajusta (desde la API del catálogo) a los que usa su matriz.
 */
export const ETAPAS_CICLO_VIDA = [
  ['adquisicion_materias_primas', 'Adquisición de materias primas'],
  ['diseno_desarrollo', 'Diseño y desarrollo'],
  ['prestacion_servicio', 'Producción o prestación del servicio'],
  ['transporte', 'Transporte y entrega'],
  ['uso', 'Uso'],
  ['tratamiento_fin_de_vida', 'Tratamiento al final de la vida'],
  ['disposicion_final', 'Disposición final'],
] as const;

/** Factores ambientales que puede afectar un impacto. Mismos criterios que las etapas: valores iniciales que QHSE ajusta. */
export const FACTORES_AMBIENTALES = [
  ['agua', 'Agua'],
  ['aire', 'Aire'],
  ['suelo', 'Suelo'],
  ['flora', 'Flora'],
  ['fauna', 'Fauna'],
  ['paisaje', 'Paisaje'],
  ['recursos_naturales', 'Recursos naturales y energía'],
  ['poblacion', 'Población'],
] as const;

/** Idempotente: solo agrega lo que falta y no toca lo que QHSE ya ajustó. */
export async function sembrarAmbiental(
  prisma: PrismaClient,
): Promise<{ frecuencias: number; etapas: number; factores: number }> {
  let frecuencias = 0;
  for (const [i, [codigo, nombre]] of FRECUENCIAS_SEGUIMIENTO.entries()) {
    if (await prisma.frecuenciaSeguimiento.count({ where: { codigo } })) continue;
    await prisma.frecuenciaSeguimiento.create({
      data: { id: uuidv7(), codigo, nombre, orden: i + 1 },
    });
    frecuencias++;
  }
  let etapas = 0;
  for (const [i, [codigo, nombre]] of ETAPAS_CICLO_VIDA.entries()) {
    if (await prisma.aspectoEtapaCicloVida.count({ where: { codigo } })) continue;
    await prisma.aspectoEtapaCicloVida.create({
      data: { id: uuidv7(), codigo, nombre, orden: i + 1 },
    });
    etapas++;
  }
  let factores = 0;
  for (const [i, [codigo, nombre]] of FACTORES_AMBIENTALES.entries()) {
    if (await prisma.aspectoFactorAmbiental.count({ where: { codigo } })) continue;
    await prisma.aspectoFactorAmbiental.create({
      data: { id: uuidv7(), codigo, nombre, orden: i + 1 },
    });
    factores++;
  }
  return { frecuencias, etapas, factores };
}
