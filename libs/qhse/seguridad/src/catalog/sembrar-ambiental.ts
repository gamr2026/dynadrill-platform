import { uuidv7 } from '@dyn/utils';
import type { PrismaClient } from '../generated/client';

/** Frecuencias de seguimiento de un plan de acción o de un aspecto ambiental. QHSE las amplía; el comportamiento nunca depende del nombre. */
export const FRECUENCIAS_SEGUIMIENTO = [
  ['mensual', 'Mensual'],
  ['trimestral', 'Trimestral'],
  ['semestral', 'Semestral'],
  ['anual', 'Anual'],
] as const;

/** Idempotente: solo agrega lo que falta y no toca lo que QHSE ya ajustó. */
export async function sembrarAmbiental(prisma: PrismaClient): Promise<{ frecuencias: number }> {
  let frecuencias = 0;
  for (const [i, [codigo, nombre]] of FRECUENCIAS_SEGUIMIENTO.entries()) {
    if (await prisma.frecuenciaSeguimiento.count({ where: { codigo } })) continue;
    await prisma.frecuenciaSeguimiento.create({
      data: { id: uuidv7(), codigo, nombre, orden: i + 1 },
    });
    frecuencias++;
  }
  return { frecuencias };
}
