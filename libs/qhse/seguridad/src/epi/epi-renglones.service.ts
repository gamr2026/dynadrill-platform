import { BadRequestException, Injectable } from '@nestjs/common';
import { uuidv7 } from '@dyn/utils';
import { texto, type RenglonEntrada, type Tx } from './epi-tipos';

/**
 * Renglones de una entrega (elementos entregados). El servicio da mensajes claros; la base garantiza lo mismo con el trigger
 * `epi_entrega_item_validar` (solo cambian mientras la entrega está solicitada o aprobada, y la talla es del tipo del elemento).
 */
@Injectable()
export class EpiRenglonesService {
  async validar(tx: Tx, renglones: RenglonEntrada[]): Promise<void> {
    if (!renglones.length) return;
    const elementos = await tx.epiElemento.findMany({
      where: { id: { in: [...new Set(renglones.map((r) => r.elementoId))] } },
    });
    const tallaIds = [...new Set(renglones.flatMap((r) => (r.tallaId ? [r.tallaId] : [])))];
    const tallas = await tx.epiTalla.findMany({ where: { id: { in: tallaIds } } });
    for (const r of renglones) {
      const el = elementos.find((x) => x.id === r.elementoId);
      if (!el || !el.activo)
        throw new BadRequestException('Algún elemento indicado no existe en el catálogo de EPI');
      if (!el.tipoTalla) {
        if (r.tallaId) throw new BadRequestException(`${el.nombre} no lleva talla`);
        continue;
      }
      if (!r.tallaId) throw new BadRequestException(`Indique la talla de: ${el.nombre}`);
      const talla = tallas.find((t) => t.id === r.tallaId);
      if (!talla || !talla.activo || talla.tipo !== el.tipoTalla)
        throw new BadRequestException(`La talla indicada no corresponde a: ${el.nombre}`);
    }
  }

  /** Reemplaza todos los renglones de la entrega (la base rechaza el cambio si ya no es editable). */
  async reemplazar(
    tx: Tx,
    entregaId: string,
    renglones: RenglonEntrada[],
    actorId: string,
  ): Promise<void> {
    await tx.epiEntregaItem.deleteMany({ where: { entregaId } });
    if (!renglones.length) return;
    await tx.epiEntregaItem.createMany({
      data: renglones.map((r) => ({
        id: uuidv7(),
        entregaId,
        elementoId: r.elementoId,
        cantidad: r.cantidad,
        tallaId: r.tallaId ?? null,
        recibioCapacitacion: r.recibioCapacitacion,
        observaciones: texto(r.observaciones),
        createdBy: actorId,
        updatedBy: actorId,
        ...(r.entregadoEl ? { entregadoEl: new Date(`${r.entregadoEl}T00:00:00.000Z`) } : {}),
      })),
    });
  }
}
