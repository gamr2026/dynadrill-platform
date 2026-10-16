import { uuidv7 } from '@dyn/utils';
import type { PrismaClient } from '../generated/client';

/**
 * Elementos de protección individual y ropa de trabajo del formato DYN-SGI-RE-032. Es una lista inicial conservadora: QHSE la
 * ajusta (altas y bajas lógicas) y la consulta a Dynadrill queda anotada en documentacion/qhse/CONSULTAS-PARA-DYNADRILL.md.
 * `requiereTalla`: ropa, calzado y guantes se entregan por talla.
 */
export const ELEMENTOS_EPI: ReadonlyArray<{ nombre: string; requiereTalla: boolean }> = [
  { nombre: 'Casco de seguridad', requiereTalla: false },
  { nombre: 'Gafas de seguridad', requiereTalla: false },
  { nombre: 'Protector facial', requiereTalla: false },
  { nombre: 'Tapones auditivos', requiereTalla: false },
  { nombre: 'Orejeras', requiereTalla: false },
  { nombre: 'Mascarilla o respirador', requiereTalla: false },
  { nombre: 'Guantes de nitrilo', requiereTalla: true },
  { nombre: 'Guantes de cuero', requiereTalla: true },
  { nombre: 'Botas de seguridad con punta de acero', requiereTalla: true },
  { nombre: 'Overol', requiereTalla: true },
  { nombre: 'Chaleco reflectivo', requiereTalla: true },
  { nombre: 'Arnés de seguridad', requiereTalla: false },
];

/** Idempotente: solo agrega los que faltan (por nombre) y no toca los que QHSE ya ajustó. */
export async function sembrarEpi(prisma: PrismaClient): Promise<{ elementos: number }> {
  const existentes = await prisma.epiElemento.findMany({ select: { nombre: true, orden: true } });
  const nombres = new Set(existentes.map((e) => e.nombre.toLowerCase()));
  let orden = existentes.reduce((m, e) => Math.max(m, e.orden), 0);
  let nuevos = 0;
  for (const e of ELEMENTOS_EPI) {
    if (nombres.has(e.nombre.toLowerCase())) continue;
    await prisma.epiElemento.create({
      data: { id: uuidv7(), nombre: e.nombre, requiereTalla: e.requiereTalla, orden: ++orden },
    });
    nuevos++;
  }
  return { elementos: nuevos };
}
