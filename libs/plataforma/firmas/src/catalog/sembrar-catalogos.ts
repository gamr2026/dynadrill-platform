import { uuidv7 } from '@dyn/utils';
import type { PrismaClient } from '../generated/client';
import { DOCUMENTOS_FIRMABLES, ROLES_FIRMANTE } from './catalogos';

/** Crea los documentos y papeles que falten (no toca los existentes). Devuelve cuántos creó de cada uno. */
export async function sembrarCatalogos(
  prisma: PrismaClient,
): Promise<{ documentos: number; roles: number }> {
  const documentos = await prisma.documentoTipo.createMany({
    data: DOCUMENTOS_FIRMABLES.map((d) => ({ id: uuidv7(), ...d })),
    skipDuplicates: true,
  });
  const roles = await prisma.rolFirmante.createMany({
    data: ROLES_FIRMANTE.map((r) => ({ id: uuidv7(), ...r })),
    skipDuplicates: true,
  });
  return { documentos: documentos.count, roles: roles.count };
}
