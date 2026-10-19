import type { Prisma } from '../generated/client';

/** Lo que se carga de una sub-orden para mostrarla completa: tipo, estado, personas y repuestos (con su artículo y bodega). */
export const INCLUIR_SUBORDEN_DETALLE = {
  tipo: true,
  estado: true,
  asignada: { select: { id: true, nombre: true } },
  asignador: { select: { id: true, nombre: true } },
  repuestos: {
    include: {
      articulo: { select: { id: true, codigo: true, nombre: true } },
      bodega: { select: { id: true, nombre: true } },
    },
    orderBy: { createdAt: 'asc' },
  },
} satisfies Prisma.SubordenInclude;

export type SubordenDetalle = Prisma.SubordenGetPayload<{
  include: typeof INCLUIR_SUBORDEN_DETALLE;
}>;

const num = (d: Prisma.Decimal | null) => (d === null ? null : Number(d));

/** Cómo se ve una sub-orden en la API (la misma en la orden y en su ejecución). `codigoReporte` es el de su orden (R0001). */
export function vistaSuborden(s: SubordenDetalle, codigoReporte: string) {
  return {
    id: s.id,
    codigo: `${codigoReporte}-${s.tipo.sufijo}`,
    ordenId: s.ordenId,
    tipo: { codigo: s.tipo.codigo, nombre: s.tipo.nombre },
    estado: { codigo: s.estado.codigo, nombre: s.estado.nombre },
    asignada: s.asignada,
    asignadaPor: s.asignador,
    notaDerivacion: s.notaDerivacion,
    notaCorreccion: s.notaCorreccion,
    diagnostico: s.diagnostico,
    actividadesCorrectivas: s.actividadesCorrectivas,
    horasTrabajo: num(s.horasTrabajo),
    trabajosAdicionales: s.trabajosAdicionales,
    ejecucionIniciadaAt: s.ejecucionIniciadaAt,
    ejecucionTerminadaAt: s.ejecucionTerminadaAt,
    cierreAprobadoAt: s.cierreAprobadoAt,
    repuestos: s.repuestos.map((x) => ({
      id: x.id,
      cantidad: Number(x.cantidad),
      articulo: x.articulo,
      bodega: x.bodega,
      numeroParte: x.numeroParte,
      descripcion: x.descripcion,
      /** Salida del kardex que respalda el renglón (solo tras aprobar el cierre). */
      movimientoId: x.movimientoId,
    })),
  };
}
