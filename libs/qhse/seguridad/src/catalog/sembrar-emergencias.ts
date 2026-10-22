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

/**
 * Cascada de notificación (HSE-TRIAGE-001, minutos 5 a 15): cada paso con su origen, su destino y su plazo desde la activación. «Base HSE»
 * sustituye al «Coordinador HSE» de la demo (rol retirado, D4).
 */
export const PASOS_CASCADA_EMERGENCIA = [
  ['Supervisor', 'Company Man', 2],
  ['Company Man', 'Base HSE', 5],
  ['Base HSE', 'Gerencia', 10],
  ['Company Man', 'Base Operadora (Cliente)', 5],
] as const;

/** Idempotente: solo agrega lo que falta y no toca lo que QHSE ya ajustó. */
export async function sembrarEmergencias(
  prisma: PrismaClient,
): Promise<{ tipos: number; pasos: number }> {
  let tipos = 0;
  for (const [i, [codigo, nombre]] of TIPOS_EMERGENCIA.entries()) {
    if (await prisma.emergenciaTipo.count({ where: { codigo } })) continue;
    await prisma.emergenciaTipo.create({ data: { id: uuidv7(), codigo, nombre, orden: i + 1 } });
    tipos++;
  }
  let pasos = 0;
  for (const [i, [desde, hacia, plazoMinutos]] of PASOS_CASCADA_EMERGENCIA.entries()) {
    if (await prisma.emergenciaPasoNotificacion.count({ where: { orden: i + 1 } })) continue;
    await prisma.emergenciaPasoNotificacion.create({
      data: { id: uuidv7(), orden: i + 1, desde, hacia, plazoMinutos },
    });
    pasos++;
  }
  return { tipos, pasos };
}
