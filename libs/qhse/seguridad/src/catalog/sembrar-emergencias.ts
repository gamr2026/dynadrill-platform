import { uuidv7 } from '@dyn/utils';
import type { PrismaClient } from '../generated/client';

/**
 * Tipos de emergencia (HSE-TRIAGE-001). La demo los tenía como texto libre (con «Derrame mayor» como sugerencia): aquí son un catálogo que QHSE
 * amplía. El comportamiento nunca depende del nombre.
 */
export const TIPOS_EMERGENCIA = [
  ['derrame_mayor', 'Derrame mayor'],
  ['incendio', 'Incendio'],
  ['explosion', 'Explosión'],
  ['accidente_heridos', 'Accidente con heridos'],
  ['fuga_gas', 'Fuga de gas'],
  ['otro', 'Otro'],
] as const;

/** Idempotente: solo agrega lo que falta y no toca lo que QHSE ya ajustó. */
export async function sembrarEmergencias(prisma: PrismaClient): Promise<{ tipos: number }> {
  let tipos = 0;
  for (const [i, [codigo, nombre]] of TIPOS_EMERGENCIA.entries()) {
    if (await prisma.emergenciaTipo.count({ where: { codigo } })) continue;
    await prisma.emergenciaTipo.create({ data: { id: uuidv7(), codigo, nombre, orden: i + 1 } });
    tipos++;
  }
  return { tipos };
}
