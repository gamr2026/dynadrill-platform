/**
 * Cálculo de la prefactura. Funciones puras (sin base de datos) para poder probar cada regla.
 *
 * Fuentes de las líneas:
 *  1. Reporte de Herramientas por ítem (FCR): una línea por fila con su CANTIDAD REAL (marcas por día o cantidad escrita), con el precio y el
 *     tipo de la lista de precios. Si el pedido tiene este reporte, lo cotizado NO se factura: manda el reporte (los cotizados que no aparecen
 *     en él solo se avisan). Es lo que hace el Excel: la cantidad del TICKET es el total de la fila del reporte.
 *  1b. Reportes anteriores (sin cantidad): una línea de RENTA por los días en operación o cargo diario y una de VENTA por los días en estado
 *     venta (el stand-by no se cobra).
 *  2. Ítems del pedido ("personal"), cuando no hay reporte por ítem: cantidad cotizada; si la unidad de la lista es por día, los días con
 *     Reporte Job.
 *  3. Ítems del pedido que ya no coinciden con la lista: se facturan con lo cotizado y se avisan ("personal_manual").
 */

export type TipoItem = 'Material' | 'Servicio';
export type FuenteItem = 'herramienta' | 'material' | 'personal' | 'personal_manual';
export type EstadoUso = 'operacion' | 'stand_by' | 'daily_charge' | 'venta';

export interface ItemLista {
  codigo: string;
  descripcion: string;
  unidad: string | null;
  precio: number;
  tipo: TipoItem;
}

export interface ItemPedido {
  codigo: string;
  descripcion: string;
  unidad: string | null;
  cantidad: number;
  valorUnitario: number;
  descuentoPct: number;
}

export interface HerramientaReportada {
  nombre: string;
  serie: string | null;
  codigo: string | null;
  /** Unidad que trae el reporte (la de la lista manda si el código existe en ella). */
  unidad?: string | null;
  /** Cantidad real del reporte por ítem; nula en los reportes anteriores. */
  cantidad?: number | null;
  usos: Array<{ estado: EstadoUso }>;
}

export interface TasasAplicadas {
  ivaPct: number;
  retencionIrPct: number;
  retencionIvaPct: number;
}

export interface LineaPrefactura {
  orden: number;
  codigo: string;
  descripcion: string;
  unidad: string | null;
  serie: string | null;
  cantidad: number;
  precioUnitario: number;
  descuentoPct: number;
  precioTotal: number;
  tipo: TipoItem;
  fuente: FuenteItem;
}

export interface Totales {
  subtotalServicios: number;
  subtotalMateriales: number;
  subtotal: number;
  iva: number;
  retencionIr: number;
  retencionIva: number;
  netoCobrar: number;
}

export interface ResultadoCalculo {
  items: LineaPrefactura[];
  totales: Totales;
  advertencias: string[];
}

/** Redondeo comercial a dos decimales. */
export const redondear = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

const PERIODO_DIA = /d[ií]a/i;

export function calcularPrefactura(entrada: {
  itemsPedido: ItemPedido[];
  herramientas: HerramientaReportada[];
  /** Días distintos con Reporte Job recibido. */
  diasReporteJob: number;
  lista: ItemLista[] | null;
  nombreLista: string | null;
  tasas: TasasAplicadas;
}): ResultadoCalculo {
  const porCodigo = new Map((entrada.lista ?? []).map((i) => [i.codigo, i]));
  const items: LineaPrefactura[] = [];
  const advertencias: string[] = [];
  const agregar = (l: Omit<LineaPrefactura, 'orden'>) => items.push({ ...l, orden: items.length });

  // 1) Herramientas reportadas
  for (const h of entrada.herramientas) {
    if (!h.codigo) {
      advertencias.push(
        `La herramienta "${h.nombre}" no tiene código: no se factura hasta completarlo.`,
      );
      continue;
    }
    const li = porCodigo.get(h.codigo);
    if (!li) {
      advertencias.push(
        `La herramienta "${h.nombre}" (código ${h.codigo}) no está en la lista de precios del cliente: no se factura.`,
      );
      continue;
    }
    if (h.cantidad !== null && h.cantidad !== undefined) {
      // reporte por ítem: la cantidad real del reporte es la que se factura
      if (h.cantidad <= 0) continue;
      agregar({
        codigo: li.codigo,
        descripcion: li.descripcion,
        unidad: li.unidad ?? h.unidad ?? null,
        serie: h.serie,
        cantidad: h.cantidad,
        precioUnitario: li.precio,
        descuentoPct: 0,
        precioTotal: redondear(h.cantidad * li.precio),
        tipo: li.tipo,
        fuente: li.tipo === 'Material' ? 'material' : 'herramienta',
      });
      continue;
    }
    // reportes anteriores (sin cantidad): el stand-by no se cobra
    const renta = h.usos.filter((u) => u.estado !== 'venta' && u.estado !== 'stand_by').length;
    const venta = h.usos.filter((u) => u.estado === 'venta').length;
    if (renta > 0) {
      agregar({
        codigo: li.codigo,
        descripcion: li.descripcion,
        unidad: li.unidad,
        serie: h.serie,
        cantidad: renta,
        precioUnitario: li.precio,
        descuentoPct: 0,
        precioTotal: redondear(renta * li.precio),
        tipo: li.tipo,
        fuente: 'herramienta',
      });
    }
    if (venta > 0) {
      agregar({
        codigo: li.codigo,
        descripcion: li.descripcion,
        unidad: 'unidad',
        serie: h.serie,
        cantidad: venta,
        precioUnitario: li.precio,
        descuentoPct: 0,
        precioTotal: redondear(venta * li.precio),
        tipo: li.tipo,
        fuente: li.tipo === 'Material' ? 'material' : 'herramienta',
      });
    }
  }

  // 2) Ítems del pedido. Con el reporte por ítem, lo cotizado no se factura: solo se avisa lo que no se reportó.
  const hayReportePorItem = entrada.herramientas.some(
    (h) => h.cantidad !== null && h.cantidad !== undefined,
  );
  if (hayReportePorItem) {
    const reportados = new Set(entrada.herramientas.map((h) => h.codigo).filter(Boolean));
    for (const it of entrada.itemsPedido) {
      if (it.cantidad > 0 && !reportados.has(it.codigo)) {
        advertencias.push(
          `El ítem cotizado ${it.codigo} (${it.cantidad}) no está en el Reporte de Herramientas: no se factura.`,
        );
      }
    }
  }
  for (const it of hayReportePorItem ? [] : entrada.itemsPedido) {
    const li = porCodigo.get(it.codigo);
    if (li) {
      const cantidad = PERIODO_DIA.test(li.unidad ?? '') ? entrada.diasReporteJob : it.cantidad;
      if (!cantidad || cantidad <= 0) continue;
      agregar({
        codigo: li.codigo,
        descripcion: li.descripcion,
        unidad: li.unidad,
        serie: null,
        cantidad,
        precioUnitario: li.precio,
        descuentoPct: it.descuentoPct,
        precioTotal: redondear(cantidad * li.precio * (1 - it.descuentoPct / 100)),
        tipo: li.tipo,
        fuente: 'personal',
      });
      continue;
    }
    if (it.cantidad <= 0) continue;
    advertencias.push(
      `El ítem ${it.codigo} ya no está en la lista de precios: se facturó con el valor cotizado (${it.valorUnitario}).`,
    );
    agregar({
      codigo: it.codigo,
      descripcion: it.descripcion,
      unidad: it.unidad,
      serie: null,
      cantidad: it.cantidad,
      precioUnitario: it.valorUnitario,
      descuentoPct: it.descuentoPct,
      precioTotal: redondear(it.cantidad * it.valorUnitario * (1 - it.descuentoPct / 100)),
      tipo: 'Material',
      fuente: 'personal_manual',
    });
  }

  if (items.length === 0) {
    advertencias.unshift(
      entrada.lista === null
        ? 'No se encontró una lista de precios activa para este cliente: no se pudo calcular ningún valor.'
        : `Ninguna línea del pedido ni herramienta reportada coincide con la lista de precios${entrada.nombreLista ? ` "${entrada.nombreLista}"` : ''}: no hay nada que facturar todavía.`,
    );
  }

  return { items, totales: totalizar(items, entrada.tasas), advertencias };
}

export function totalizar(items: LineaPrefactura[], t: TasasAplicadas): Totales {
  const suma = (tipo: TipoItem) =>
    redondear(items.filter((i) => i.tipo === tipo).reduce((s, i) => s + i.precioTotal, 0));
  const subtotalServicios = suma('Servicio');
  const subtotalMateriales = suma('Material');
  const subtotal = redondear(subtotalServicios + subtotalMateriales);
  const iva = redondear((subtotal * t.ivaPct) / 100);
  const retencionIr = redondear((subtotal * t.retencionIrPct) / 100);
  const retencionIva = redondear((iva * t.retencionIvaPct) / 100);
  return {
    subtotalServicios,
    subtotalMateriales,
    subtotal,
    iva,
    retencionIr,
    retencionIva,
    netoCobrar: redondear(subtotal + iva - retencionIr - retencionIva),
  };
}
