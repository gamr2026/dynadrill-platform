import { uuidv7 } from '@dyn/utils';
import type { PrismaClient } from '../generated/client';

/** Características CRETIB de un desecho peligroso (HSE-AMBIENTAL-001). */
export const CARACTERISTICAS_CRETIB = [
  ['corrosivo', 'Corrosivo'],
  ['reactivo', 'Reactivo'],
  ['explosivo', 'Explosivo'],
  ['toxico', 'Tóxico'],
  ['inflamable', 'Inflamable'],
  ['biologico_infeccioso', 'Biológico-infeccioso'],
] as const;

/** Código de color de contenedor: convención interna de Dynadrill, no una norma citada en HSE-AMBIENTAL-001. */
export const CONTENEDORES_DESECHO = [
  ['rojo', 'Rojo', 'Biológico-infeccioso'],
  ['negro', 'Negro', 'Peligroso general'],
  ['gris', 'Gris', 'No peligroso / común'],
  ['verde', 'Verde', 'Orgánico'],
  ['azul', 'Azul', 'Reciclable'],
] as const;

/** Estados del ciclo; los triggers de la base deciden por estos códigos. */
export const ESTADOS_DESECHO = [
  ['almacenado', 'Almacenado'],
  ['con_manifiesto', 'Con manifiesto'],
  ['dispuesto', 'Dispuesto'],
] as const;

/** Idempotente: solo agrega lo que falta y no toca lo que QHSE ya ajustó. */
export async function sembrarDesechos(
  prisma: PrismaClient,
): Promise<{ caracteristicas: number; contenedores: number; estados: number }> {
  let caracteristicas = 0;
  for (const [i, [codigo, nombre]] of CARACTERISTICAS_CRETIB.entries()) {
    if (await prisma.desechoCaracteristica.count({ where: { codigo } })) continue;
    await prisma.desechoCaracteristica.create({
      data: { id: uuidv7(), codigo, nombre, orden: i + 1 },
    });
    caracteristicas++;
  }
  let contenedores = 0;
  for (const [i, [codigo, nombre, uso]] of CONTENEDORES_DESECHO.entries()) {
    if (await prisma.desechoContenedor.count({ where: { codigo } })) continue;
    await prisma.desechoContenedor.create({
      data: { id: uuidv7(), codigo, nombre, uso, orden: i + 1 },
    });
    contenedores++;
  }
  let estados = 0;
  for (const [i, [codigo, nombre]] of ESTADOS_DESECHO.entries()) {
    if (await prisma.desechoEstado.count({ where: { codigo } })) continue;
    await prisma.desechoEstado.create({ data: { id: uuidv7(), codigo, nombre, orden: i + 1 } });
    estados++;
  }
  return { caracteristicas, contenedores, estados };
}
