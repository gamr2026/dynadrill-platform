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
 * Plantillas del módulo FCR. Cada regla liga un evento y un rol con el texto que ese cargo debe leer; para que otro cargo reciba el mismo
 * aviso con otras palabras se agrega su plantilla y su regla (sin tocar código).
 */
export const PLANTILLAS_FCR: PlantillaDef[] = [
  {
    codigo: 'fcr_ticket_creado_supervisor',
    descripcion:
      'Un pedido de FCR llegó a la bandeja del Supervisor (entrada VENTA: revisión inicial; entrada SERVICIOS: tipo de operador).',
    asunto: 'Nuevo pedido de FCR para atender: {{pedidoCodigo}} — {{cliente}}',
    cuerpoHtml:
      '<p>Hola {{nombre}},</p>' +
      '<p>Como <strong>{{cargo}}</strong>, tiene un nuevo pedido de FCR en su bandeja (tipo de OT: <strong>{{tipoOt}}</strong>):</p>' +
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
      '<p>Revise los datos del pedido y continúe con el primer paso del servicio.</p>',
    cuerpoTexto:
      'Hola {{nombre}},\n\nComo {{cargo}}, tiene un nuevo pedido de FCR en su bandeja (tipo de OT: {{tipoOt}}):\n\n' +
      'Ticket: {{ticketNumero}}\nPedido: {{pedidoCodigo}}\nCliente: {{cliente}}\nCampo: {{campo}}\nPozo: {{pozo}}\nTaladro: {{taladro}}\n' +
      'Servicio: {{servicios}}\nInicio del servicio: {{fechaInicioServicio}}\n\n' +
      'Revise los datos del pedido y continúe con el primer paso del servicio.',
    tituloAviso: 'Nuevo pedido de FCR: {{pedidoCodigo}}',
    detalleAviso: '{{cliente}} · Pozo {{pozo}} — {{tipoOt}}',
    enlaceAviso: '/modulos/operativo/fcr/pedidos/{{ticketId}}',
    tono: 'warning',
    evento: 'operaciones.fcr.ticket_creado',
    rol: 'supervisor',
  },
  {
    codigo: 'fcr_asignacion_supervisor',
    descripcion:
      'El Supervisor asignó el equipo de un servicio de FCR (aviso a la cuenta del supervisor).',
    asunto: 'Quedó asignado como supervisor del servicio {{pedidoCodigo}} — {{cliente}}',
    cuerpoHtml:
      '<p>Hola {{nombre}},</p>' +
      '<p>{{asignadoPor}} asignó el equipo del siguiente servicio de FCR, del que usted es el <strong>Supervisor</strong>:</p>' +
      DATOS_ASIGNACION +
      '<p>El servicio está en <strong>Reunión operativa</strong>.</p>',
    cuerpoTexto:
      'Hola {{nombre}},\n\n{{asignadoPor}} asignó el equipo del siguiente servicio de FCR, del que usted es el Supervisor:\n\n' +
      TEXTO_ASIGNACION +
      '\n\nEl servicio está en Reunión operativa.',
    tituloAviso: 'Equipo asignado: {{pedidoCodigo}}',
    detalleAviso: '{{cliente}} · Pozo {{pozo}} · Operadores {{operadores}}',
    enlaceAviso: '/modulos/operativo/fcr/pedidos/{{ticketId}}',
    tono: 'info',
    evento: 'operaciones.fcr.asignacion_realizada',
    rol: 'supervisor',
  },
  {
    codigo: 'fcr_asignacion_operador',
    descripcion: 'El Supervisor asignó a un Operador FCR a un servicio (solo a la cuenta elegida).',
    asunto: 'Fue asignado como operador del servicio {{pedidoCodigo}} — {{cliente}}',
    cuerpoHtml:
      '<p>Hola {{nombre}},</p>' +
      '<p>{{asignadoPor}} lo asignó como <strong>Operador</strong> del siguiente servicio de FCR:</p>' +
      DATOS_ASIGNACION +
      '<p>Su supervisor es <strong>{{supervisor}}</strong>. El servicio está en <strong>Reunión operativa</strong>.</p>',
    cuerpoTexto:
      'Hola {{nombre}},\n\n{{asignadoPor}} lo asignó como Operador del siguiente servicio de FCR:\n\n' +
      TEXTO_ASIGNACION +
      '\n\nSu supervisor es {{supervisor}}. El servicio está en Reunión operativa.',
    tituloAviso: 'Asignado como operador: {{pedidoCodigo}}',
    detalleAviso: '{{cliente}} · Pozo {{pozo}}',
    enlaceAviso: '/modulos/operativo/fcr/pedidos/{{ticketId}}',
    tono: 'info',
    evento: 'operaciones.fcr.asignacion_realizada',
    rol: 'operador',
  },
];
