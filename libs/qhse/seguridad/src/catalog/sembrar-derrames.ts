import { uuidv7 } from '@dyn/utils';
import type { PrismaClient } from '../generated/client';

/**
 * Dónde cayó el derrame (HSE-AMBIENTAL-002). El comportamiento sale de las columnas: un derrame en cuerpo de agua exige notificar al MAE y
 * escala a emergencia; el de suelo genera un desecho; sobre geomembrana (contenido) no exige nada por sí solo.
 */
export const UBICACIONES_DERRAME = [
  {
    codigo: 'geomembrana',
    nombre: 'Sobre geomembrana (contenido)',
    exigeNotificacionMae: false,
    escalaAEmergencia: false,
    generaDesecho: false,
  },
  {
    codigo: 'suelo',
    nombre: 'Suelo natural',
    exigeNotificacionMae: false,
    escalaAEmergencia: false,
    generaDesecho: true,
  },
  {
    codigo: 'cuerpo_agua',
    nombre: 'Cuerpo de agua',
    exigeNotificacionMae: true,
    escalaAEmergencia: true,
    generaDesecho: false,
  },
] as const;

/**
 * Bandas de volumen en barriles [desde, hasta). **POR CONFIRMAR CON DYNADRILL**: son el supuesto de la demo (menor < 1, moderado 1 a 5, mayor
 * 5 o más), no valores definitivos. QHSE las ajusta desde la configuración y, al confirmarlas, quita la marca `porConfirmar`.
 */
export const BANDAS_VOLUMEN_DERRAME = [
  {
    codigo: 'menor',
    nombre: 'Menor (< 1 barril)',
    desde: 0,
    hasta: 1,
    exigeNotificacionMae: false,
    escalaAEmergencia: false,
  },
  {
    codigo: 'moderado',
    nombre: 'Moderado (1 a 5 barriles)',
    desde: 1,
    hasta: 5,
    exigeNotificacionMae: false,
    escalaAEmergencia: false,
  },
  {
    codigo: 'mayor',
    nombre: 'Mayor (5 barriles o más)',
    desde: 5,
    hasta: null,
    exigeNotificacionMae: true,
    escalaAEmergencia: true,
  },
] as const;

/** Checklist de contención de los primeros 5 minutos (HSE-AMBIENTAL-002). El derrame solo pasa a contenido con todos los pasos confirmados. */
export const PASOS_CONTENCION_DERRAME = [
  ['detener_fuente', 'Detener la fuente del derrame si es seguro hacerlo'],
  ['delimitar_area', 'Delimitar el área con barreras o absorbentes'],
  ['evitar_drenajes', 'Evitar que llegue a drenajes o cuerpos de agua'],
  ['usar_epp', 'Usar el EPP adecuado antes de intervenir'],
  ['notificar_qhse', 'Notificar a QHSE inmediatamente'],
] as const;

/** Idempotente: solo agrega lo que falta y no toca lo que QHSE ya ajustó (ni quita la marca «por confirmar» de una banda). */
export async function sembrarDerrames(
  prisma: PrismaClient,
): Promise<{ ubicaciones: number; bandas: number; pasos: number }> {
  let ubicaciones = 0;
  for (const [i, u] of UBICACIONES_DERRAME.entries()) {
    if (await prisma.derrameUbicacion.count({ where: { codigo: u.codigo } })) continue;
    await prisma.derrameUbicacion.create({ data: { id: uuidv7(), ...u, orden: i + 1 } });
    ubicaciones++;
  }
  let bandas = 0;
  for (const [i, b] of BANDAS_VOLUMEN_DERRAME.entries()) {
    if (await prisma.derrameBandaVolumen.count({ where: { codigo: b.codigo } })) continue;
    await prisma.derrameBandaVolumen.create({
      data: {
        id: uuidv7(),
        codigo: b.codigo,
        nombre: b.nombre,
        orden: i + 1,
        desdeBarriles: b.desde,
        hastaBarriles: b.hasta,
        exigeNotificacionMae: b.exigeNotificacionMae,
        escalaAEmergencia: b.escalaAEmergencia,
        porConfirmar: true,
      },
    });
    bandas++;
  }
  let pasos = 0;
  for (const [i, [codigo, nombre]] of PASOS_CONTENCION_DERRAME.entries()) {
    if (await prisma.derrameChecklistItem.count({ where: { codigo } })) continue;
    await prisma.derrameChecklistItem.create({
      data: { id: uuidv7(), codigo, nombre, orden: i + 1 },
    });
    pasos++;
  }
  return { ubicaciones, bandas, pasos };
}
