import type { Prisma } from '../generated/client';

type Db = Pick<Prisma.TransactionClient, 'orden' | 'tipoSuborden'>;

/** Lo que los avisos necesitan para escribir el texto (el código de la unidad y de la orden) y que el evento no debe obligar a consultar. */
export async function datosDeOrden(db: Db, ordenId: string) {
  const o = await db.orden.findUniqueOrThrow({
    where: { id: ordenId },
    select: { reporte: { select: { codigo: true, unidad: { select: { codigo: true } } } } },
  });
  return { ordenCodigo: o.reporte.codigo, unidad: o.reporte.unidad.codigo };
}

/** Nombre del tipo y código de una sub-orden (código de la orden + sufijo del tipo, como en pantalla). */
export async function datosDeSuborden(db: Db, ordenCodigo: string, tipoCodigo: string) {
  const t = await db.tipoSuborden.findUniqueOrThrow({ where: { codigo: tipoCodigo } });
  return { tipoNombre: t.nombre, subordenCodigo: `${ordenCodigo}-${t.sufijo}` };
}
