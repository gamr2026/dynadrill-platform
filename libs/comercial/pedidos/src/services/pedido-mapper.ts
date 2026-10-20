import { Prisma } from '../generated/client';

const dia = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const num = (d: Prisma.Decimal | number | null | undefined) =>
  d === null || d === undefined ? null : Number(d);
const redondeo = (n: number) => Math.round(n * 100) / 100;

/**
 * Los nombres de catálogos y personas salen de las FK (JOIN), no se copian al pedido. Este `include` se agrega a toda consulta
 * de pedido cuyo resultado pase por el mapper.
 */
export const INCLUDE_NOMBRES = {
  cliente: true,
  campo: { include: { zona: true } },
  bloque: true,
  pozo: true,
  taladro: true,
  bodega: true,
  condicionPago: true,
  agenteComercial: true,
  tecnicoHse: true,
  analistaFacturacion: true,
  representanteCampo: true,
  representanteQuito: true,
} as const satisfies Prisma.PedidoInclude;

type ConNombres = Prisma.PedidoGetPayload<{ include: typeof INCLUDE_NOMBRES }>;

export type PedidoConHijos = Prisma.PedidoGetPayload<{
  include: typeof INCLUDE_NOMBRES & {
    items: true;
    linea: true;
    tipoOt: true;
    documentos: { include: { archivo: true } };
    tiposServicio: { include: { tipo: true; subtipos: { include: { catalogo: true } } } };
    estadoRef: true;
    ticketOperativo: true;
  };
}>;

/** Nombre del cliente: el fiscal si existe, si no el comercial; si el cliente no está en el catálogo, el que trae AS2. */
export const nombreCliente = (
  p: Pick<ConNombres, 'cliente' | 'as2EmpresaNombre'>,
): string | null =>
  p.cliente ? (p.cliente.nombreFiscal ?? p.cliente.nombreComercial) : p.as2EmpresaNombre;
export const rucCliente = (
  p: Pick<ConNombres, 'cliente' | 'as2EmpresaIdentificacion'>,
): string | null => (p.cliente ? p.cliente.identificacion : p.as2EmpresaIdentificacion);
/** La zona es la del campo; si el pedido no tiene campo, la que trae AS2. */
const zonaDe = (p: Pick<ConNombres, 'campo' | 'as2Zona'>) => p.campo?.zona ?? null;

/** Importes de un ítem: bruto, descuento y neto (dos decimales). */
export function importesItem(i: {
  cantidad: Prisma.Decimal | number;
  valorUnitario: Prisma.Decimal | number;
  descuentoPct: Prisma.Decimal | number | null;
}) {
  const bruto = redondeo(Number(i.cantidad) * Number(i.valorUnitario));
  const descuento = redondeo((bruto * Number(i.descuentoPct ?? 0)) / 100);
  return { bruto, descuento, neto: redondeo(bruto - descuento) };
}

export function toItem(i: PedidoConHijos['items'][number]) {
  return {
    id: i.id,
    orden: i.orden,
    codigo: i.codigo,
    descripcion: i.descripcion,
    unidad: i.unidad,
    cantidad: num(i.cantidad),
    valorUnitario: num(i.valorUnitario),
    descuentoPct: num(i.descuentoPct),
    origenItem: i.origenItem,
    tipoLinea: i.tipoLinea,
    listaPreciosItemId: i.listaPreciosItemId,
    ...importesItem(i),
  };
}

/** Resumen para la lista de pedidos (sin ítems). */
export function toResumen(
  p: Prisma.PedidoGetPayload<{
    include: typeof INCLUDE_NOMBRES & {
      estadoRef: true;
      linea: true;
      tipoOt: true;
      tiposServicio: { include: { tipo: true } };
    };
  }>,
) {
  return {
    id: p.id,
    codigo: p.codigo,
    ticketNumero: p.ticketNumero,
    origen: p.origen,
    estado: p.estado,
    estadoNombre: p.estadoRef.nombre,
    macroEstado: p.estadoRef.macroEstado,
    rolResponsable: p.estadoRef.rolResponsable,
    clienteId: p.clienteId,
    clienteNombre: nombreCliente(p),
    lineaServicio: p.linea?.codigo ?? null,
    tipoOt: p.tipoOt?.codigo ?? null,
    tiposServicio: p.tiposServicio.map((t) => t.tipo.codigo),
    campoNombre: p.campo?.nombre ?? null,
    pozoNombre: p.pozo?.nombreCompleto ?? null,
    taladroNombre: p.rigless ? 'Rigless' : (p.taladro?.nombre ?? null),
    agenteComercialNombre: p.agenteComercial?.nombre ?? null,
    analistaFacturacionNombre: p.analistaFacturacion?.nombre ?? null,
    fechaInicioServicio: dia(p.fechaInicioServicio),
    fechaFinServicio: dia(p.fechaFinServicio),
    as2Numero: p.as2Numero,
    as2Estado: p.as2Estado,
    as2SyncEstado: p.as2SyncEstado,
    version: p.version,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

export function toDetalle(p: PedidoConHijos) {
  const items = [...p.items].sort((a, b) => a.orden - b.orden).map(toItem);
  const subtotal = redondeo(items.reduce((a, i) => a + i.bruto, 0));
  const descuento = redondeo(items.reduce((a, i) => a + i.descuento, 0));
  return {
    id: p.id,
    codigo: p.codigo,
    ticketNumero: p.ticketNumero,
    /** El ticket de Operaciones que lo atiende y el código de su paso actual (el nombre lo pone el frontend desde el catálogo). */
    ticketOperativo: p.ticketOperativo
      ? {
          origen: p.ticketOperativo.origen,
          ticketId: p.ticketOperativo.ticketId,
          pasoCodigo: p.ticketOperativo.pasoCodigo,
          actualizadoAt: p.ticketOperativo.actualizadoAt,
        }
      : null,
    version: p.version,
    origen: p.origen,
    estado: p.estado,
    estadoNombre: p.estadoRef.nombre,
    macroEstado: p.estadoRef.macroEstado,
    rolResponsable: p.estadoRef.rolResponsable,
    terminal: p.estadoRef.terminal,
    motivoAnulacion: p.motivoAnulacion,
    anuladoAt: p.anuladoAt,
    cliente: {
      id: p.clienteId,
      nombre: nombreCliente(p),
      ruc: rucCliente(p),
      subcliente: p.subcliente,
    },
    lineaServicio: p.linea?.codigo ?? null,
    tipoOt: p.tipoOt?.codigo ?? null,
    tiposServicio: p.tiposServicio.map((t) => t.tipo.codigo).sort(),
    subtiposServicio: p.tiposServicio
      .flatMap((t) => t.subtipos.map((x) => ({ tipo: t.tipo.codigo, subtipo: x.catalogo.nombre })))
      .sort((a, b) => a.tipo.localeCompare(b.tipo) || a.subtipo.localeCompare(b.subtipo)),
    ubicacion: {
      campoId: p.campoId,
      campo: p.campo?.nombre ?? null,
      bloqueId: p.bloqueId,
      bloque: p.bloque?.nombre ?? null,
      pozoId: p.pozoId,
      pozo: p.pozo?.nombreCompleto ?? null,
      taladroId: p.taladroId,
      taladro: p.taladro?.nombre ?? null,
      rigless: p.rigless,
    },
    numeroContrato: p.numeroContrato,
    fechaInicioServicio: dia(p.fechaInicioServicio),
    fechaFinServicio: dia(p.fechaFinServicio),
    responsables: {
      agenteComercial: { id: p.agenteComercialId, nombre: p.agenteComercial?.nombre ?? null },
      representanteCampo: {
        id: p.representanteCampoId,
        nombre: p.representanteCampo?.nombre ?? null,
      },
      representanteQuito: {
        id: p.representanteQuitoId,
        nombre: p.representanteQuito?.nombre ?? null,
      },
      tecnicoHse: { id: p.tecnicoHseId, nombre: p.tecnicoHse?.nombre ?? null },
      analistaFacturacion: {
        id: p.analistaFacturacionId,
        nombre: p.analistaFacturacion?.nombre ?? null,
        asignadoAt: p.analistaAsignadoAt,
      },
    },
    administrativo: {
      condicionPagoId: p.condicionPagoId,
      condicionPago: p.condicionPago?.nombre ?? p.as2CondicionPago,
      zonaId: p.campo?.zonaId ?? null,
      zona: zonaDe(p)?.nombre ?? p.as2Zona,
      bodegaId: p.bodegaId,
      bodega: p.bodega?.nombre ?? p.as2Bodega,
      solicitudMedio: p.solicitudMedio,
    },
    items,
    totales: { subtotal, descuento, neto: redondeo(subtotal - descuento) },
    documentos: [...p.documentos]
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((d) => ({
        id: d.id,
        archivoId: d.archivoId,
        nombre: d.archivo.nombreOriginal,
        mimeType: d.archivo.mimeType,
        tamanoBytes: Number(d.archivo.tamanoBytes),
        subidoPor: d.archivo.subidoPor,
        createdAt: d.createdAt,
      })),
    as2: {
      idPedidoCliente: p.as2IdPedidoCliente,
      numero: p.as2Numero,
      estado: p.as2Estado,
      fecha: dia(p.as2Fecha),
      total: num(p.as2Total),
      descuento: num(p.as2Descuento),
      impuesto: num(p.as2Impuesto),
      /** Total final de AS2: `total` es el subtotal bruto. */
      totalFinal:
        p.as2Total === null
          ? null
          : redondeo(Number(p.as2Total) - Number(p.as2Descuento ?? 0) + Number(p.as2Impuesto ?? 0)),
      descripcion: p.as2Descripcion,
      syncEstado: p.as2SyncEstado,
      vinculoMetodo: p.as2VinculoMetodo,
      sincronizadoAt: p.as2SincronizadoAt,
    },
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}
