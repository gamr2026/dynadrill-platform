import { uuidv7 } from '@dyn/utils';
import type { PrismaClient } from '../generated/client';
import { PLANTILLAS } from './plantillas';

export { PLANTILLAS } from './plantillas';

type Cliente = Pick<PrismaClient, 'plantilla' | 'reglaAviso'>;

/** Idempotente: lo que ya existe no se toca (un administrador puede haber ajustado el texto). */
export async function sembrarPlantillas(
  db: Cliente,
): Promise<{ plantillas: number; reglas: number }> {
  let plantillas = 0;
  let reglas = 0;
  for (const p of PLANTILLAS) {
    let pl = await db.plantilla.findUnique({ where: { codigo: p.codigo } });
    if (!pl) {
      pl = await db.plantilla.create({
        data: {
          id: uuidv7(),
          codigo: p.codigo,
          descripcion: p.descripcion,
          asunto: p.asunto,
          cuerpoHtml: p.cuerpoHtml,
          cuerpoTexto: p.cuerpoTexto,
          tituloAviso: p.tituloAviso,
          detalleAviso: p.detalleAviso,
          enlaceAviso: p.enlaceAviso,
          tono: p.tono,
        },
      });
      plantillas++;
    }
    const regla = await db.reglaAviso.findUnique({
      where: { eventoTipo_rolCodigo: { eventoTipo: p.evento, rolCodigo: p.rol } },
      select: { id: true },
    });
    if (!regla) {
      await db.reglaAviso.create({
        data: { id: uuidv7(), eventoTipo: p.evento, rolCodigo: p.rol, plantillaId: pl.id },
      });
      reglas++;
    }
  }
  return { plantillas, reglas };
}
