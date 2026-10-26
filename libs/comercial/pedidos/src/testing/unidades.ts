import type { PrismaService } from '../prisma/prisma.service';

/**
 * Id de una unidad del catálogo compartido por su nombre (CM-4: la unidad ya no se escribe como texto en listas, pedidos
 * ni reportes). Falla con un mensaje claro si la unidad no está sembrada.
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
