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

/** QHSE aprobó el PTW del día: el supervisor asignado (el evento trae `asignados`) ya puede operar ese día. */
const ptwAprobadoSupervisor: PlantillaDef = {
  codigo: 'qhse_ptw_cerrado_supervisor',
  descripcion:
    'QHSE aprobó el permiso de trabajo (PTW) de un día de operación: avisa al supervisor asignado al ticket.',
  asunto: 'PTW aprobado: {{codigo}} — {{pedidoCodigo}} ({{diaOperacion}})',
  cuerpoHtml:
    '<p>Hola {{nombre}},</p>' +
    '<p>QHSE aprobó el permiso de trabajo <strong>{{codigo}}</strong> del día <strong>{{diaOperacion}}</strong>. Ya puede operar ese día.</p>' +
    '<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;margin:8px 0 16px">' +
    FILA('Ticket', 'ticketNumero') +
    FILA('Pedido', 'pedidoCodigo') +
    FILA('Cliente', 'cliente') +
    '</table>',
  cuerpoTexto:
    'Hola {{nombre}},\n\nQHSE aprobó el permiso de trabajo {{codigo}} del día {{diaOperacion}}. Ya puede operar ese día.\n\nTicket: {{ticketNumero}}\nPedido: {{pedidoCodigo}}\nCliente: {{cliente}}',
  tituloAviso: 'PTW aprobado: {{codigo}}',
  detalleAviso: '{{pedidoCodigo}} · {{diaOperacion}}',
  enlaceAviso: '/modulos/operativo/pumping/pedidos/{{ticketId}}',
  tono: 'info',
  evento: 'qhse.ptw.cerrado',
  rol: 'supervisor',
};

/** Una SWA activada: la cadena (Supervisor, Técnico y Gerente HSE) debe enterarse al instante. El evento trae `asignados`. */
const swaActivada = (rol: 'supervisor' | 'tecnico_hse' | 'gerente_hse'): PlantillaDef => ({
  codigo: `qhse_swa_activado_${rol}`,
  descripcion:
    'Un trabajador activó una SWA (Stop Work Authority): avisa a la cadena de notificación.',
  asunto: 'SWA activada: {{codigo}} — trabajo detenido ({{tipoPeligroNombre}})',
  cuerpoHtml:
    '<p>Hola {{nombre}},</p>' +
    '<p>Como <strong>{{cargo}}</strong>, debe saber que se activó la <strong>{{codigo}}</strong>: el trabajo está detenido hasta que se evalúe el riesgo y se reanude.</p>' +
    '<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;margin:8px 0 16px">' +
    FILA('Peligro', 'tipoPeligroNombre') +
    FILA('Descripción', 'descripcion') +
    FILA('Ubicación', 'ubicacion') +
    FILA('Ticket', 'ticketNumero') +
    FILA('Pedido', 'pedidoCodigo') +
    FILA('Cliente', 'cliente') +
    FILA('Activada por', 'activadoPor') +
    '</table>' +
    '<p>Política de cero represalias: nadie puede ser sancionado por detener un trabajo de buena fe.</p>',
  cuerpoTexto:
    'Hola {{nombre}},\n\nComo {{cargo}}, debe saber que se activó la {{codigo}}: el trabajo está detenido hasta que se evalúe el riesgo y se reanude.\n\nPeligro: {{tipoPeligroNombre}}\nDescripción: {{descripcion}}\nUbicación: {{ubicacion}}\nTicket: {{ticketNumero}}\nPedido: {{pedidoCodigo}}\nCliente: {{cliente}}\nActivada por: {{activadoPor}}\n\nPolítica de cero represalias: nadie puede ser sancionado por detener un trabajo de buena fe.',
  tituloAviso: 'SWA activada: {{codigo}}',
  detalleAviso: '{{tipoPeligroNombre}} · {{pedidoCodigo}}',
  enlaceAviso: '/dashboard/qhse/swa',
  tono: 'error',
  evento: 'qhse.swa.activado',
  rol,
});

/**
 * Plantillas del módulo QHSE. Cada regla liga un evento y un rol con el texto que ese cargo debe leer; los demás subdominios de QHSE
 * agregan aquí las suyas (SWA, PTW, documentos por vencer...).
 */
export const PLANTILLAS_QHSE: PlantillaDef[] = [
  solicitudesDeEpi('tecnico_hse'),
  solicitudesDeEpi('gerente_hse'),
  ptwAprobadoSupervisor,
  swaActivada('supervisor'),
  swaActivada('tecnico_hse'),
  swaActivada('gerente_hse'),
];
