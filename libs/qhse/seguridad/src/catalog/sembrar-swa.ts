import { uuidv7 } from '@dyn/utils';
import type { PrismaClient } from '../generated/client';

/** Tipos de peligro habituales en una locación (HSE-SEGUIMIENTO-003). QHSE los amplía; el comportamiento nunca depende del nombre. */
export const TIPOS_PELIGRO_SWA = [
  ['mecanico', 'Mecánico (equipos, herramientas, presión)'],
  ['electrico', 'Eléctrico'],
  ['quimico', 'Químico (productos, gases)'],
  ['ambiental', 'Ambiental (derrame, fuga)'],
  ['caida', 'Caída de personas u objetos'],
  ['ergonomico', 'Ergonómico'],
  ['incendio', 'Incendio o explosión'],
  ['otro', 'Otro'],
] as const;

/** Roles de la cadena de notificación (el Coordinador HSE se retiró: D4). */
export const ROLES_CADENA_SWA = ['supervisor', 'tecnico_hse', 'gerente_hse'] as const;

/** Checklist de reinicio de trabajos del formato. */
export const CRITERIOS_REINICIO_SWA = [
  ['peligro_corregido', 'El peligro identificado fue corregido o controlado'],
  ['personal_informado', 'El personal involucrado fue informado de la solución'],
  ['supervisor_confirma', 'El supervisor confirma condiciones seguras para reanudar'],
] as const;

/** Idempotente: solo agrega lo que falta y no toca lo que QHSE ya ajustó. */
export async function sembrarSwa(
  prisma: PrismaClient,
): Promise<{ tipos: number; roles: number; criterios: number }> {
  let tipos = 0;
  for (const [i, [codigo, nombre]] of TIPOS_PELIGRO_SWA.entries()) {
    if (await prisma.swaTipoPeligro.count({ where: { codigo } })) continue;
    await prisma.swaTipoPeligro.create({ data: { id: uuidv7(), codigo, nombre, orden: i + 1 } });
    tipos++;
  }
  let criterios = 0;
  for (const [i, [codigo, nombre]] of CRITERIOS_REINICIO_SWA.entries()) {
    if (await prisma.swaCriterioReinicio.count({ where: { codigo } })) continue;
    await prisma.swaCriterioReinicio.create({
      data: { id: uuidv7(), codigo, nombre, orden: i + 1 },
    });
    criterios++;
  }
  let roles = 0;
  for (const [i, codigo] of ROLES_CADENA_SWA.entries()) {
    const rol = await prisma.idRol.findFirst({ where: { codigo }, select: { id: true } });
    if (!rol) throw new Error(`El rol ${codigo} no existe: corra antes npm run db:seed:identidad`);
    if (await prisma.swaRolCadena.count({ where: { rolId: rol.id } })) continue;
    await prisma.swaRolCadena.create({ data: { id: uuidv7(), rolId: rol.id, orden: i + 1 } });
    roles++;
  }
  return { tipos, roles, criterios };
}
