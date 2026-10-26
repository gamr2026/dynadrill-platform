import type { PrismaService } from '../prisma/prisma.service';

/**
 * Id de una unidad del catálogo compartido por su nombre (OP-6: las líneas, el reporte y los cambios de ítems ya no llevan
 * la unidad como texto). Falla con un mensaje claro si la unidad no está sembrada.
 */
export async function idsDeUnidades(prisma: PrismaService): Promise<(nombre: string) => string> {
  const filas = await prisma.catUnidadMedida.findMany({ select: { id: true, nombre: true } });
  const porNombre = new Map(filas.map((f) => [f.nombre.toLowerCase(), f.id]));
  return (nombre) => {
    const id = porNombre.get(nombre.toLowerCase());
    if (!id) throw new Error(`Falta la unidad «${nombre}» en catalogos.unidad_medida`);
    return id;
  };
}
