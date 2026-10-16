import { uuidv7 } from '@dyn/utils';
import { Prisma, PrismaClient, type TransformacionCampo } from '../generated/client';

type Json = Prisma.InputJsonValue;
type Cliente = Pick<PrismaClient, 'proveedor' | 'operacion' | 'mapeoCampo'>;

interface Mapeo {
  destino: string;
  origen: string;
  transformacion?: TransformacionCampo;
  obligatorio?: boolean;
}

/** Primer id de pedido de cliente de AS2 que se considera "de este año" (los anteriores no se muestran). */
export const ID_PEDIDO_DESDE = 14305;

const ORG = { campo: 'idOrganizacion', valor: '{{var.idOrganizacion}}', operador: '=' };
const DESDE = { campo: 'idPedidoCliente', valor: '{{var.idPedidoDesde}}', operador: '>=' };

const CAMPOS_CABECERA = [
  'idPedidoCliente',
  'numero',
  'fecha',
  'estado',
  'total',
  'descuento',
  'impuesto',
  'descripcion',
  'empresa.nombreFiscal',
  'empresa.identificacion',
  'bodega.nombre',
  'condicionPago.nombre',
];

const CABECERA: Mapeo[] = [
  {
    destino: 'idPedidoCliente',
    origen: 'idPedidoCliente',
    transformacion: 'entero',
    obligatorio: true,
  },
  { destino: 'numero', origen: 'numero', transformacion: 'texto' },
  { destino: 'fecha', origen: 'fecha', transformacion: 'fecha_ms_ec' },
  { destino: 'estado', origen: 'estado', transformacion: 'texto' },
  { destino: 'total', origen: 'total', transformacion: 'numero' },
  { destino: 'descuento', origen: 'descuento', transformacion: 'numero' },
  { destino: 'impuesto', origen: 'impuesto', transformacion: 'numero' },
  { destino: 'descripcion', origen: 'descripcion', transformacion: 'texto' },
  { destino: 'empresaNombre', origen: 'empresa.nombreFiscal', transformacion: 'texto' },
  { destino: 'empresaIdentificacion', origen: 'empresa.identificacion', transformacion: 'texto' },
  { destino: 'bodega', origen: 'bodega.nombre', transformacion: 'texto' },
  { destino: 'condicionPago', origen: 'condicionPago.nombre', transformacion: 'texto' },
];

const SOLO_ID: Mapeo[] = [
  {
    destino: 'idPedidoCliente',
    origen: 'idPedidoCliente',
    transformacion: 'entero',
    obligatorio: true,
  },
  { destino: 'estado', origen: 'estado', transformacion: 'texto' },
];

const LINEAS: Mapeo[] = [
  { destino: 'codigo', origen: 'producto.codigo', transformacion: 'texto' },
  { destino: 'nombre', origen: 'producto.nombre', transformacion: 'texto' },
  { destino: 'cantidad', origen: 'cantidad', transformacion: 'numero' },
  { destino: 'precio', origen: 'precio', transformacion: 'numero' },
];

/** Una página: el servicio pide `desde` y `tamano` (AS2 cuenta desde 0). */
const PAGINA = { primerResultado: '{{param.desde}}', resultadoMaximo: '{{param.tamano}}' };
const ORDEN = [{ nombre: 'idPedidoCliente', orden: -1 }];

const PAGINACION_COMPLETA: Json = {
  tipo: 'offset',
  tamano: 1000,
  inicio: 0,
  campoDesde: 'primerResultado',
  campoTamano: 'resultadoMaximo',
};

const OPERACIONES: Array<{
  codigo: string;
  descripcion: string;
  ruta: string;
  cuerpo: Json;
  paginacion?: Json;
  mapeos: Mapeo[];
}> = [
  {
    codigo: 'pedidos_pagina',
    descripcion: 'Una página de pedidos de cliente del año (más recientes primero)',
    ruta: '/v2/catalogors/pedidoCliente',
    cuerpo: { ...PAGINA, campos: CAMPOS_CABECERA, filtros: [ORG, DESDE], camposOrden: ORDEN },
    mapeos: CABECERA,
  },
  {
    codigo: 'pedidos_pagina_estado',
    descripcion: 'Una página de pedidos del año filtrada por estado. param.operador: "=" o "!="',
    ruta: '/v2/catalogors/pedidoCliente',
    cuerpo: {
      ...PAGINA,
      campos: CAMPOS_CABECERA,
      filtros: [
        ORG,
        DESDE,
        { campo: 'estado', operador: '{{param.operador}}', valor: '{{param.estado}}' },
      ],
      camposOrden: ORDEN,
    },
    mapeos: CABECERA,
  },
  {
    codigo: 'pedidos_buscar_texto',
    descripcion:
      'Pedidos del año cuya descripción contiene un texto (like %texto%, sin distinguir mayúsculas)',
    ruta: '/v2/catalogors/pedidoCliente',
    cuerpo: {
      ...PAGINA,
      campos: CAMPOS_CABECERA,
      filtros: [ORG, DESDE, { campo: 'descripcion', operador: 'like', valor: '%{{param.texto}}%' }],
      camposOrden: ORDEN,
    },
    mapeos: CABECERA,
  },
  {
    codigo: 'pedidos_ids',
    descripcion:
      'Ids y estado de TODOS los pedidos del año (para contar y para el barrido de filtros)',
    ruta: '/v2/catalogors/pedidoCliente',
    cuerpo: { campos: ['idPedidoCliente', 'estado'], filtros: [ORG, DESDE], camposOrden: ORDEN },
    paginacion: PAGINACION_COMPLETA,
    mapeos: SOLO_ID,
  },
  {
    codigo: 'pedido_por_id',
    descripcion: 'Cabecera de un pedido de cliente por su id',
    ruta: '/v2/catalogors/pedidoCliente',
    cuerpo: {
      primerResultado: 0,
      resultadoMaximo: 1,
      campos: CAMPOS_CABECERA,
      filtros: [ORG, { campo: 'idPedidoCliente', operador: '=', valor: '{{param.id}}' }],
    },
    mapeos: CABECERA,
  },
  {
    codigo: 'lineas_pedido',
    descripcion: 'Líneas de un pedido de cliente (los ELABORADO no devuelven líneas por API)',
    ruta: '/v2/catalogors/detallePedidoCliente',
    cuerpo: {
      campos: [
        'idDetallePedidoCliente',
        'cantidad',
        'precio',
        'producto.codigo',
        'producto.nombre',
      ],
      filtros: [
        ORG,
        { campo: 'pedidoCliente.idPedidoCliente', operador: '=', valor: '{{param.id}}' },
      ],
      camposOrden: [{ nombre: 'idDetallePedidoCliente', orden: 1 }],
    },
    paginacion: PAGINACION_COMPLETA,
    mapeos: LINEAS,
  },
];

/**
 * Agrega al proveedor `as2` las operaciones de lectura de pedidos de cliente. Idempotente: solo crea las que faltan
 * (no pisa versiones que un administrador haya ajustado) y fija la variable `idPedidoDesde` si no existe.
 *
 * @returns cuántas operaciones creó.
 */
export async function sembrarAs2Pedidos(db: Cliente): Promise<number> {
  const prov = await db.proveedor.findUnique({ where: { codigo: 'as2' } });
  if (!prov) return 0;
  const variables = (prov.variables ?? {}) as Record<string, unknown>;
  if (variables['idPedidoDesde'] === undefined) {
    await db.proveedor.update({
      where: { id: prov.id },
      data: { variables: { ...variables, idPedidoDesde: ID_PEDIDO_DESDE } },
    });
  }

  let creadas = 0;
  for (const o of OPERACIONES) {
    const existe = await db.operacion.findFirst({
      where: { proveedorId: prov.id, codigo: o.codigo },
      select: { id: true },
    });
    if (existe) continue;
    const id = uuidv7();
    await db.operacion.create({
      data: {
        id,
        proveedorId: prov.id,
        codigo: o.codigo,
        version: 1,
        activa: true,
        descripcion: o.descripcion,
        metodo: 'POST',
        ruta: o.ruta,
        cuerpo: o.cuerpo,
        paginacion: o.paginacion ?? Prisma.JsonNull,
        rutaResultados: '',
        requiereAuth: true,
      },
    });
    await db.mapeoCampo.createMany({
      data: o.mapeos.map((m, i) => ({
        id: uuidv7(),
        operacionId: id,
        destino: m.destino,
        origen: m.origen,
        transformacion: m.transformacion ?? null,
        obligatorio: m.obligatorio ?? false,
        orden: i,
      })),
    });
    creadas++;
  }
  return creadas;
}
