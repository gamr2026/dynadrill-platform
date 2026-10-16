import { uuidv7 } from '@dyn/utils';
import type { PrismaClient } from '../generated/client';

type Cliente = Pick<PrismaClient, 'tasaImpuesto'>;

/**
 * Tasas de impuestos y retenciones con su vigencia. IVA 15 % desde el 1/4/2024; retención de IR 1 % sobre el subtotal y
 * retención de IVA 30 % sobre el IVA (las que usa la demo; Contabilidad debe confirmarlas: ver CONSULTAS-PARA-DYNADRILL).
 */
export const TASAS_INICIALES = [
  { tipo: 'iva', porcentaje: 15, vigenteDesde: '2024-04-01' },
  { tipo: 'retencion_ir', porcentaje: 1, vigenteDesde: '2020-01-01' },
  { tipo: 'retencion_iva', porcentaje: 30, vigenteDesde: '2020-01-01' },
] as const;

/** Idempotente: solo agrega la que falta (por tipo y vigencia); no pisa lo que Contabilidad haya cambiado. */
export async function sembrarTasas(db: Cliente): Promise<number> {
  let nuevas = 0;
  for (const t of TASAS_INICIALES) {
    const vigenteDesde = new Date(`${t.vigenteDesde}T00:00:00.000Z`);
    const existe = await db.tasaImpuesto.findUnique({
      where: { tipo_vigenteDesde: { tipo: t.tipo, vigenteDesde } },
      select: { id: true },
    });
    if (!existe) {
      await db.tasaImpuesto.create({
        data: { id: uuidv7(), tipo: t.tipo, porcentaje: t.porcentaje, vigenteDesde },
      });
      nuevas++;
    }
  }
  return nuevas;
}
