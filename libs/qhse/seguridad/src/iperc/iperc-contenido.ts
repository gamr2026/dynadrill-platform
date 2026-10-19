import { uuidv7 } from '@dyn/utils';
import { texto, type Tx } from '../epi/epi-tipos';
import type { TareaDto } from './iperc.dto';

/** Inserta las tareas de una matriz con sus cargos, peligros (valoración inicial y residual) y controles. La base valida cada fila. */
export async function insertarContenido(
  tx: Tx,
  matrizId: string,
  tareas: TareaDto[],
): Promise<void> {
  for (const [i, t] of tareas.entries()) {
    const tareaId = uuidv7();
    await tx.ipercTarea.create({
      data: {
        id: tareaId,
        matrizId,
        orden: i + 1,
        descripcion: t.descripcion.trim(),
        rutinaria: t.rutinaria,
        areaPuesto: texto(t.areaPuesto),
      },
    });
    const cargos = [...new Set(t.cargoIds ?? [])];
    if (cargos.length)
      await tx.ipercTareaCargo.createMany({
        data: cargos.map((cargoId) => ({ tareaId, cargoId })),
      });
    for (const [j, p] of t.peligros.entries()) {
      const peligroId = uuidv7();
      await tx.ipercPeligro.create({
        data: {
          id: peligroId,
          tareaId,
          orden: j + 1,
          descripcion: p.descripcion.trim(),
          clasificacionId: p.clasificacionId,
          fuenteRiesgo: texto(p.fuenteRiesgo),
          generadoEnId: p.generadoEnId ?? null,
          efectosPosibles: texto(p.efectosPosibles),
          controlExistenteFuente: texto(p.controlExistenteFuente),
          controlExistenteMedio: texto(p.controlExistenteMedio),
          controlExistenteIndividuo: texto(p.controlExistenteIndividuo),
          numeroExpuestos: p.numeroExpuestos ?? null,
          peorConsecuencia: texto(p.peorConsecuencia),
          requisitoLegal: p.requisitoLegal ?? false,
          seguimiento: texto(p.seguimiento),
          seguimientoResidual: texto(p.seguimientoResidual),
          inicialNd: p.inicial?.nd ?? null,
          inicialNe: p.inicial?.ne ?? null,
          inicialNc: p.inicial?.nc ?? null,
          residualNd: p.residual?.nd ?? null,
          residualNe: p.residual?.ne ?? null,
          residualNc: p.residual?.nc ?? null,
        },
      });
      const controles = (p.controles ?? []).filter((c) => texto(c.descripcion));
      if (controles.length)
        await tx.ipercControl.createMany({
          data: controles.map((c) => ({
            id: uuidv7(),
            peligroId,
            momento: c.momento,
            tipo: c.tipo,
            descripcion: c.descripcion.trim(),
          })),
        });
    }
  }
}
