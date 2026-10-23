import { uuidv7 } from '@dyn/utils';
import type { PrismaClient } from '../generated/client';

/** Matrices de requisitos legales que maneja QHSE (las dos de la demo). QHSE puede ampliar el catálogo; el comportamiento nunca depende del nombre. */
export const TIPOS_REQUISITO_LEGAL = [
  ['ambiente', 'Requisitos legales: Gestión Ambiental'],
  ['sst', 'Requisitos legales: Seguridad y Salud en el Trabajo'],
] as const;

/** Idempotente: solo agrega lo que falta y no toca lo que QHSE ya ajustó. */
export async function sembrarRequisitosLegales(prisma: PrismaClient): Promise<{ tipos: number }> {
  let tipos = 0;
  for (const [i, [codigo, nombre]] of TIPOS_REQUISITO_LEGAL.entries()) {
    if (await prisma.requisitoLegalTipo.count({ where: { codigo } })) continue;
    await prisma.requisitoLegalTipo.create({
      data: { id: uuidv7(), codigo, nombre, orden: i + 1 },
    });
    tipos++;
  }
  return { tipos };
}
