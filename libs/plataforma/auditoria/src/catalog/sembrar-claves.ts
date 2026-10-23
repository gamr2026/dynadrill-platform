import { uuidv7 } from '@dyn/utils';
import type { PrismaClient } from '../generated/client';
import { CLAVES_DATO } from './claves-dato';

/** Crea las claves que falten (no toca las existentes). Devuelve cuántas creó. */
export async function sembrarClaves(prisma: PrismaClient): Promise<number> {
  const r = await prisma.claveDato.createMany({
    data: CLAVES_DATO.map((c) => ({ id: uuidv7(), codigo: c.codigo, descripcion: c.descripcion })),
    skipDuplicates: true,
  });
  return r.count;
}
