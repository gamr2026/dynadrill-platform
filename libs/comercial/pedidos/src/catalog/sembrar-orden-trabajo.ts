import { uuidv7 } from '@dyn/utils';
import type { PrismaClient } from '../generated/client';

type Cliente = Pick<PrismaClient, 'ciudadOt' | 'firmanteContratista' | 'listaPrecios'>;

/** Texto del contrato 2025201 que imprime la OT (tomado de la demo y del formato OTQ). */
export const TEXTO_CONTRATO_2025201 =
  'CONTRATO 2025201 - SERVICIOS EVENTUALES BAJO LLAMADA DE APOYO A LAS OPERACIONES, SERVICIOS DE ESTIMULACIÓN Y ' +
  'LIMPIEZA DE POZOS, ACTIVIDADES RELACIONADAS CON LA PRODUCCIÓN, COMPLETACION INICIAL DE POZOS, RENTA DE ' +
  'HERRAMIENTAS DE REACONDICIONAMIENTO/COMPLETACIÓN Y PROVISIÓN DE INSUMOS Y MATERIALES PARA ACTIVIDADES DE ' +
  'CEMENTACIÓN Y TRATAMIENTO DE FLUIDOS ÚNICAMENTE PARA LA PRESTACIÓN DE SERVICIOS RELACIONADOS AL OBJETO DEL ' +
  'CONTRATO EN LOS CAMPOS DE EP PETROECUADOR INCLUIDO BLOQUE 6 (OFFSHORE)';

/**
 * Catálogos de la orden de trabajo. Idempotente. El firmante de la contratista y el contrato 2025201 vienen de la demo
 * y del formato OTQ; se confirman con Dynadrill (ver CONSULTAS-PARA-DYNADRILL.md).
 */
export async function sembrarOrdenTrabajo(
  db: Cliente,
): Promise<{ ciudades: number; firmantes: number; listas: number }> {
  let ciudades = 0;
  if (!(await db.ciudadOt.findUnique({ where: { codigo: 'UIO' }, select: { id: true } }))) {
    await db.ciudadOt.create({ data: { id: uuidv7(), codigo: 'UIO', nombre: 'Quito' } });
    ciudades++;
  }
  let firmantes = 0;
  if (!(await db.firmanteContratista.findFirst({ select: { id: true } }))) {
    await db.firmanteContratista.create({
      data: {
        id: uuidv7(),
        nombre: 'Ab. Mónica Rojas',
        cargo: 'Representante Legal',
        predeterminado: true,
      },
    });
    firmantes++;
  }
  // el contrato 2025201 (EP Petroecuador) exige la OT
  const r = await db.listaPrecios.updateMany({
    where: { numeroContrato: '2025201', requiereOrdenTrabajo: false, textoContrato: null },
    data: { requiereOrdenTrabajo: true, textoContrato: TEXTO_CONTRATO_2025201 },
  });
  return { ciudades, firmantes, listas: r.count };
}
