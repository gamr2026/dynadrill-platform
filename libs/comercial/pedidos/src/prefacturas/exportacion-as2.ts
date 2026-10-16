/** Una fila de la plantilla de carga de AS2 ("AS2 Prefactura Cliente.xlsx"). */
export interface FilaAs2 {
  codigoProducto: string;
  codigoUnidad: string;
  cantidad: number;
  descripcion: string;
  precio: number;
  porcentajeDescuento: number;
}

export interface ItemParaAs2 {
  codigo: string | null;
  descripcion: string;
  unidad: string | null;
  cantidad: number;
  precioUnitario: number;
  descuentoPct: number | null;
}

/**
 * Códigos de unidad de AS2 conocidos. La plantilla de ejemplo solo trae `UN`; las demás unidades de la lista de precios
 * (día, hora, mes…) no tienen equivalencia confirmada y quedan como aviso hasta que Asinfo la entregue
 * (ver CONSULTAS-PARA-ASINFO.md).
 */
const UNIDADES_AS2: Record<string, string> = { unidad: 'UN', un: 'UN', unidades: 'UN' };

export const CABECERA_AS2 = [
  'Codigo Producto AS2',
  'Codigo Unidad AS2',
  'Cantidad',
  'Descripción',
  'Precio',
  'Porcentaje Descuento',
] as const;

/** Arma las filas de la plantilla con las líneas de la prefactura y avisa de lo que AS2 no podrá reconocer. */
export function filasParaAs2(items: ItemParaAs2[]): { filas: FilaAs2[]; advertencias: string[] } {
  const advertencias: string[] = [];
  const sinUnidad = new Set<string>();
  const filas = items.map((i) => {
    const unidad = (i.unidad ?? '').trim();
    const codigoUnidad = UNIDADES_AS2[unidad.toLowerCase()] ?? unidad;
    if (!UNIDADES_AS2[unidad.toLowerCase()]) sinUnidad.add(unidad || '(sin unidad)');
    if (!i.codigo)
      advertencias.push(`"${i.descripcion}" no tiene código: AS2 no podrá reconocer el producto`);
    return {
      codigoProducto: i.codigo ?? '',
      codigoUnidad,
      cantidad: i.cantidad,
      descripcion: i.descripcion,
      precio: i.precioUnitario,
      porcentajeDescuento: i.descuentoPct ?? 0,
    };
  });
  if (sinUnidad.size) {
    advertencias.push(
      `Unidades sin código de AS2 confirmado (se exportan tal cual): ${[...sinUnidad].join(', ')}`,
    );
  }
  return { filas, advertencias };
}
