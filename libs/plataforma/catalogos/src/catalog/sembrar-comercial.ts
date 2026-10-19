import { uuidv7 } from '@dyn/utils';
import type { PrismaClient } from '../generated/client';

type Cliente = Pick<PrismaClient, 'bodega' | 'condicionPago'>;

/**
 * Bodegas y condiciones de pago que AS2 usa en los pedidos de cliente de 2026 (AS2 no expone estas listas por API:
 * se tomaron de los pedidos). `as2Id` es el id del registro en AS2.
 */
export const BODEGAS_AS2: Array<{ as2Id?: number; nombre: string }> = [
  { as2Id: 1, nombre: 'Bodega Matriz' },
  { as2Id: 2, nombre: 'Bodega PETROECUADOR' },
  { as2Id: 51, nombre: 'Bodega PAÑATURI' },
  { as2Id: 101, nombre: 'BODEGA SLB' },
  { as2Id: 151, nombre: 'BODEGA ORION' },
  { as2Id: 251, nombre: 'BODEGA WAYRA' },
  { as2Id: 451, nombre: 'BODEGA GENTE OIL' },
  { as2Id: 651, nombre: 'Bodega PETROBELL' },
  { as2Id: 705, nombre: 'BODEGA CONSORCIO SHUSHUFINDI' },
  { as2Id: 803, nombre: 'BODEGA ECUASERVOIL' },
  { as2Id: 903, nombre: 'BODEGA PCR' },
  // Bodegas internas que solo aparecen en el reporte de stock de AS2 (17/10/2026), con su número de bodega (22 y 23) en el nombre de AS2;
  // el id interno de AS2 no se conoce todavía (`as2Id` vacío).
  { nombre: 'BODEGA SUMINISTROS Y MANTENIMIENTO' },
  { nombre: 'EQUIPO DE PROTECCION PERSONAL (EPP)' },
];

export const CONDICIONES_PAGO_AS2: Array<{ as2Id: number; nombre: string }> = [
  { as2Id: 3, nombre: '30 dias' },
  { as2Id: 4, nombre: '45 dias' },
  { as2Id: 6, nombre: '60 dias' },
  { as2Id: 101, nombre: '90 dias' },
  { as2Id: 51, nombre: '120 dias' },
];

/** Idempotente: solo agrega lo que falta (por id de AS2 o por nombre); no pisa lo que un administrador haya editado. */
export async function sembrarComercial(
  db: Cliente,
): Promise<{ bodegas: number; condiciones: number }> {
  let bodegas = 0;
  for (const b of BODEGAS_AS2) {
    const existe = await db.bodega.findFirst({
      where: {
        OR: [
          ...(b.as2Id !== undefined ? [{ as2Id: b.as2Id }] : []),
          { nombre: { equals: b.nombre, mode: 'insensitive' as const } },
        ],
      },
      select: { id: true },
    });
    if (!existe) {
      await db.bodega.create({ data: { id: uuidv7(), as2Id: b.as2Id ?? null, nombre: b.nombre } });
      bodegas++;
    }
  }
  let condiciones = 0;
  for (const c of CONDICIONES_PAGO_AS2) {
    const existe = await db.condicionPago.findFirst({
      where: { OR: [{ as2Id: c.as2Id }, { nombre: { equals: c.nombre, mode: 'insensitive' } }] },
      select: { id: true },
    });
    if (!existe) {
      await db.condicionPago.create({ data: { id: uuidv7(), as2Id: c.as2Id, nombre: c.nombre } });
      condiciones++;
    }
  }
  return { bodegas, condiciones };
}
