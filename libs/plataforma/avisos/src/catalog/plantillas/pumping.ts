import { FILA, type PlantillaDef } from './tipos';

const DATOS_ASIGNACION =
  '<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;margin:8px 0 16px">' +
  FILA('Ticket', 'ticketNumero') +
  FILA('Pedido', 'pedidoCodigo') +
  FILA('Cliente', 'cliente') +
  FILA('Campo', 'campo') +
  FILA('Pozo', 'pozo') +
  FILA('Taladro', 'taladro') +
  FILA('Supervisor', 'supervisor') +
  FILA('Operadores', 'operadores') +
  FILA('Unidades', 'unidades') +
  FILA('Inicio del servicio', 'fechaInicioServicio') +
  '</table>';
const TEXTO_ASIGNACION =
  'Ticket: {{ticketNumero}}\nPedido: {{pedidoCodigo}}\nCliente: {{cliente}}\nCampo: {{campo}}\nPozo: {{pozo}}\nTaladro: {{taladro}}\n' +
  'Supervisor: {{supervisor}}\nOperadores: {{operadores}}\nUnidades: {{unidades}}\nInicio del servicio: {{fechaInicioServicio}}';

/**
 * Plantillas del módulo Pumping. Cada regla liga un evento y un rol con el texto que ese cargo debe leer; para que otro cargo reciba el
 * mismo aviso con otras palabras se agrega su plantilla y su regla (sin tocar código).
 */
export const PLANTILLAS_PUMPING: PlantillaDef[] = [
  {
    codigo: 'pumping_ticket_creado_jefe_base',
    descripcion:
      'Un pedido de Pumping llegó a la bandeja del Jefe de Base para su revisión inicial.',
    asunto: 'Nuevo pedido de Pumping para revisar: {{pedidoCodigo}} — {{cliente}}',
    cuerpoHtml:
      '<p>Hola {{nombre}},</p>' +
      '<p>Como <strong>{{cargo}}</strong>, tiene un nuevo pedido de Pumping en su bandeja, en el paso <em>Revisión inicial</em>:</p>' +
      '<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;margin:8px 0 16px">' +
      FILA('Ticket', 'ticketNumero') +
      FILA('Pedido', 'pedidoCodigo') +
      FILA('Cliente', 'cliente') +
      FILA('Campo', 'campo') +
      FILA('Pozo', 'pozo') +
      FILA('Taladro', 'taladro') +
      FILA('Servicio', 'servicios') +
      FILA('Inicio del servicio', 'fechaInicioServicio') +
      '</table>' +
      '<p>Revise los datos del pedido y, si está conforme, páselo a <strong>Asignación</strong> para designar al equipo.</p>',
    cuerpoTexto:
      'Hola {{nombre}},\n\nComo {{cargo}}, tiene un nuevo pedido de Pumping en su bandeja, en el paso Revisión inicial:\n\n' +
      'Ticket: {{ticketNumero}}\nPedido: {{pedidoCodigo}}\nCliente: {{cliente}}\nCampo: {{campo}}\nPozo: {{pozo}}\nTaladro: {{taladro}}\n' +
      'Servicio: {{servicios}}\nInicio del servicio: {{fechaInicioServicio}}\n\n' +
      'Revise los datos del pedido y, si está conforme, páselo a Asignación para designar al equipo.',
    tituloAviso: 'Nuevo pedido de Pumping: {{pedidoCodigo}}',
    detalleAviso: '{{cliente}} · Pozo {{pozo}} — pendiente de revisión inicial',
    enlaceAviso: '/modulos/operativo/pumping/pedidos/{{ticketId}}',
    tono: 'warning',
    evento: 'operaciones.pumping.ticket_creado',
    rol: 'jefe_base',
  },
  {
    codigo: 'pumping_asignacion_supervisor',
    descripcion:
      'El Jefe de Base asignó al Supervisor a un servicio de Pumping (solo a la cuenta elegida).',
    asunto: 'Fue asignado como supervisor del servicio {{pedidoCodigo}} — {{cliente}}',
    cuerpoHtml:
      '<p>Hola {{nombre}},</p>' +
      '<p>{{asignadoPor}} lo asignó como <strong>Supervisor</strong> del siguiente servicio de Pumping:</p>' +
      DATOS_ASIGNACION +
      '<p>Coordine con los operadores y las unidades indicadas. El servicio está en <strong>Traslado de salida</strong>.</p>',
    cuerpoTexto:
      'Hola {{nombre}},\n\n{{asignadoPor}} lo asignó como Supervisor del siguiente servicio de Pumping:\n\n' +
      TEXTO_ASIGNACION +
      '\n\nCoordine con los operadores y las unidades indicadas. El servicio está en Traslado de salida.',
    tituloAviso: 'Asignado como supervisor: {{pedidoCodigo}}',
    detalleAviso: '{{cliente}} · Pozo {{pozo}} · Unidades {{unidades}}',
    enlaceAviso: '/modulos/operativo/pumping/pedidos/{{ticketId}}',
    tono: 'info',
    evento: 'operaciones.pumping.asignacion_realizada',
    rol: 'supervisor',
  },
  {
    codigo: 'pumping_asignacion_operador',
    descripcion:
      'El Jefe de Base asignó a un Operador a un servicio de Pumping (solo a la cuenta elegida).',
    asunto: 'Fue asignado como operador del servicio {{pedidoCodigo}} — {{cliente}}',
    cuerpoHtml:
      '<p>Hola {{nombre}},</p>' +
      '<p>{{asignadoPor}} lo asignó como <strong>Operador</strong> del siguiente servicio de Pumping:</p>' +
      DATOS_ASIGNACION +
      '<p>Su supervisor es <strong>{{supervisor}}</strong>. El servicio está en <strong>Traslado de salida</strong>.</p>',
    cuerpoTexto:
      'Hola {{nombre}},\n\n{{asignadoPor}} lo asignó como Operador del siguiente servicio de Pumping:\n\n' +
      TEXTO_ASIGNACION +
      '\n\nSu supervisor es {{supervisor}}. El servicio está en Traslado de salida.',
    tituloAviso: 'Asignado como operador: {{pedidoCodigo}}',
    detalleAviso: '{{cliente}} · Pozo {{pozo}} · Unidades {{unidades}}',
    enlaceAviso: '/modulos/operativo/pumping/pedidos/{{ticketId}}',
    tono: 'info',
    evento: 'operaciones.pumping.asignacion_realizada',
    rol: 'operador',
  },
  {
    codigo: 'pumping_salida_reportada_supervisor',
    descripcion:
      'El equipo terminó el traslado de salida: el Supervisor asignado debe revisar los reportes de salida.',
    asunto: 'Salida reportada, pendiente de su revisión: {{pedidoCodigo}} — {{cliente}}',
    cuerpoHtml:
      '<p>Hola {{nombre}},</p>' +
      '<p>{{reportadoPor}} completó el <strong>traslado de salida</strong> del siguiente servicio de Pumping. Los reportes de salida esperan su revisión:</p>' +
      '<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;margin:8px 0 16px">' +
      FILA('Ticket', 'ticketNumero') +
      FILA('Pedido', 'pedidoCodigo') +
      FILA('Cliente', 'cliente') +
      FILA('Campo', 'campo') +
      FILA('Pozo', 'pozo') +
      FILA('Taladro', 'taladro') +
      FILA('Unidades', 'unidades') +
      '</table>' +
      '<p>El servicio está en <strong>Revisión de reportes de salida</strong>.</p>',
    cuerpoTexto:
      'Hola {{nombre}},\n\n{{reportadoPor}} completó el traslado de salida del siguiente servicio de Pumping. Los reportes de salida esperan su revisión:\n\n' +
      'Ticket: {{ticketNumero}}\nPedido: {{pedidoCodigo}}\nCliente: {{cliente}}\nCampo: {{campo}}\nPozo: {{pozo}}\nTaladro: {{taladro}}\nUnidades: {{unidades}}\n\n' +
      'El servicio está en Revisión de reportes de salida.',
    tituloAviso: 'Salida reportada: {{pedidoCodigo}}',
    detalleAviso:
      '{{cliente}} · Pozo {{pozo}} · Unidades {{unidades}} — revise los reportes de salida',
    enlaceAviso: '/modulos/operativo/pumping/pedidos/{{ticketId}}',
    tono: 'warning',
    evento: 'operaciones.pumping.salida_reportada',
    rol: 'supervisor',
  },
];
