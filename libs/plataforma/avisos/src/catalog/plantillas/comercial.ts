import type { PlantillaDef } from './tipos';

/** Plantillas de Comercial (pedidos y Facturación). */
export const PLANTILLAS_COMERCIAL: PlantillaDef[] = [
  {
    codigo: 'comercial_analista_asignado',
    descripcion:
      'La jefa de Facturación le asignó (o reasignó) un pedido a un analista: el aviso es solo para la cuenta de ese analista.',
    asunto: 'Se le asignó el pedido {{codigo}} para facturar',
    cuerpoHtml:
      '<p>Hola {{nombre}},</p>' +
      '<p>Se le asignó el pedido <strong>{{codigo}}</strong> como analista de Facturación.</p>' +
      '<p>Ingrese al pedido para revisar su documentación y continuar con la prefactura.</p>',
    cuerpoTexto:
      'Hola {{nombre}},\n\nSe le asignó el pedido {{codigo}} como analista de Facturación.\n\n' +
      'Ingrese al pedido para revisar su documentación y continuar con la prefactura.',
    tituloAviso: 'Pedido asignado: {{codigo}}',
    detalleAviso: 'Usted es el analista de Facturación de este pedido.',
    enlaceAviso: '/dashboard/facturacion/pedidos/{{pedidoId}}',
    tono: 'info',
    evento: 'comercial.pedido.analista_asignado',
    rol: 'facturacion',
  },
];
