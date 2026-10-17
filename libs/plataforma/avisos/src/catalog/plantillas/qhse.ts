import { FILA, type PlantillaDef } from './tipos';

const DATOS =
  '<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;margin:8px 0 16px">' +
  FILA('Ticket', 'ticketNumero') +
  FILA('Pedido', 'pedidoCodigo') +
  FILA('Cliente', 'cliente') +
  FILA('Campo', 'campo') +
  FILA('Pozo', 'pozo') +
  FILA('Trabajadores', 'trabajadores') +
  '</table>';
const TEXTO =
  'Ticket: {{ticketNumero}}\nPedido: {{pedidoCodigo}}\nCliente: {{cliente}}\nCampo: {{campo}}\nPozo: {{pozo}}\nTrabajadores: {{trabajadores}}';

/** Un aviso por asignación (no uno por operador): el mismo texto para el Técnico y para el Gerente HSE. */
const solicitudesDeEpi = (rol: 'tecnico_hse' | 'gerente_hse'): PlantillaDef => ({
  codigo: `qhse_epi_solicitudes_abiertas_${rol}`,
  descripcion:
    'Pumping asignó al equipo de un servicio: QHSE tiene solicitudes de entrega de EPI por revisar.',
  asunto: 'Entrega de EPI por revisar: {{pedidoCodigo}} — {{cliente}}',
  cuerpoHtml:
    '<p>Hola {{nombre}},</p>' +
    '<p>Como <strong>{{cargo}}</strong>, tiene <strong>{{cantidad}}</strong> solicitud(es) de entrega de EPI por revisar, de los operadores asignados a este servicio de Pumping:</p>' +
    DATOS +
    '<p>Apruebe cada solicitud, registre los elementos entregados y despache: el servicio no puede salir del traslado de salida sin el EPI despachado.</p>',
  cuerpoTexto:
    'Hola {{nombre}},\n\nComo {{cargo}}, tiene {{cantidad}} solicitud(es) de entrega de EPI por revisar, de los operadores asignados a este servicio de Pumping:\n\n' +
    TEXTO +
    '\n\nApruebe cada solicitud, registre los elementos entregados y despache: el servicio no puede salir del traslado de salida sin el EPI despachado.',
  tituloAviso: 'EPI por revisar: {{pedidoCodigo}}',
  detalleAviso: '{{cliente}} · {{trabajadores}}',
  enlaceAviso: '/dashboard/qhse/epi',
  tono: 'warning',
  evento: 'qhse.epi.solicitudes_abiertas',
  rol,
});

/**
 * Plantillas del módulo QHSE. Cada regla liga un evento y un rol con el texto que ese cargo debe leer; los demás subdominios de QHSE
 * agregan aquí las suyas (SWA, PTW, documentos por vencer...).
 */
export const PLANTILLAS_QHSE: PlantillaDef[] = [
  solicitudesDeEpi('tecnico_hse'),
  solicitudesDeEpi('gerente_hse'),
];
