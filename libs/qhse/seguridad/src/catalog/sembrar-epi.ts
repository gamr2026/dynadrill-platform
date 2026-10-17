import { uuidv7 } from '@dyn/utils';
import type { PrismaClient, TipoTalla } from '../generated/client';

/**
 * Elementos de protección individual y ropa de trabajo del formato DYN-SGI-RE-032. Lista inicial conservadora: QHSE la ajusta (altas
 * y bajas lógicas) y la consulta a Dynadrill queda anotada en documentacion/qhse/CONSULTAS-PARA-DYNADRILL.md. `codigo` es estable
 * (nunca cambia el comportamiento por el nombre); `tipoTalla` dice qué tallas admite (`null` = no lleva talla).
 */
export const ELEMENTOS_EPI: ReadonlyArray<{
  codigo: string;
  nombre: string;
  tipoTalla: TipoTalla | null;
}> = [
  { codigo: 'casco', nombre: 'Casco de seguridad', tipoTalla: null },
  { codigo: 'gafas', nombre: 'Gafas de seguridad', tipoTalla: null },
  { codigo: 'protector_facial', nombre: 'Protector facial', tipoTalla: null },
  { codigo: 'tapones_auditivos', nombre: 'Tapones auditivos', tipoTalla: null },
  { codigo: 'orejeras', nombre: 'Orejeras', tipoTalla: null },
  { codigo: 'respirador', nombre: 'Mascarilla o respirador', tipoTalla: null },
  { codigo: 'guantes_nitrilo', nombre: 'Guantes de nitrilo', tipoTalla: 'guante' },
  { codigo: 'guantes_cuero', nombre: 'Guantes de cuero', tipoTalla: 'guante' },
  {
    codigo: 'botas_punta_acero',
    nombre: 'Botas de seguridad con punta de acero',
    tipoTalla: 'calzado',
  },
  { codigo: 'overol', nombre: 'Overol', tipoTalla: 'ropa' },
  { codigo: 'chaleco_reflectivo', nombre: 'Chaleco reflectivo', tipoTalla: 'ropa' },
  { codigo: 'arnes', nombre: 'Arnés de seguridad', tipoTalla: null },
];

export const TALLAS_EPI: Readonly<Record<TipoTalla, readonly string[]>> = {
  ropa: ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL'],
  calzado: ['35', '36', '37', '38', '39', '40', '41', '42', '43', '44', '45', '46'],
  guante: ['7', '8', '9', '10', '11'],
};

/** Idempotente: solo agrega los que faltan (por código) y no toca lo que QHSE ya ajustó. */
export async function sembrarEpi(
  prisma: PrismaClient,
): Promise<{ elementos: number; tallas: number }> {
  const elementos = await prisma.epiElemento.findMany({ select: { codigo: true, orden: true } });
  const codigos = new Set(elementos.map((e) => e.codigo));
  let orden = elementos.reduce((m, e) => Math.max(m, e.orden), 0);
  let nuevosElementos = 0;
  for (const e of ELEMENTOS_EPI) {
    if (codigos.has(e.codigo)) continue;
    await prisma.epiElemento.create({
      data: {
        id: uuidv7(),
        codigo: e.codigo,
        nombre: e.nombre,
        tipoTalla: e.tipoTalla,
        orden: ++orden,
      },
    });
    nuevosElementos++;
  }

  let nuevasTallas = 0;
  for (const [tipo, codigosTalla] of Object.entries(TALLAS_EPI) as [
    TipoTalla,
    readonly string[],
  ][]) {
    const existentes = await prisma.epiTalla.findMany({
      where: { tipo },
      select: { codigo: true },
    });
    const ya = new Set(existentes.map((t) => t.codigo));
    for (const [i, codigo] of codigosTalla.entries()) {
      if (ya.has(codigo)) continue;
      await prisma.epiTalla.create({ data: { id: uuidv7(), tipo, codigo, orden: i + 1 } });
      nuevasTallas++;
    }
  }
  return { elementos: nuevosElementos, tallas: nuevasTallas };
}
