import { FILA, ROL_DEL_EVENTO, type PlantillaDef } from './tipos';

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
  FILA('Conductores', 'conductores') +
  FILA('Unidades', 'unidades') +
  FILA('Inicio del servicio', 'fechaInicioServicio') +
  '</table>';
const TEXTO_ASIGNACION =
  'Ticket: {{ticketNumero}}\nPedido: {{pedidoCodigo}}\nCliente: {{cliente}}\nCampo: {{campo}}\nPozo: {{pozo}}\nTaladro: {{taladro}}\n' +
  'Supervisor: {{supervisor}}\nOperadores: {{operadores}}\nConductores: {{conductores}}\nUnidades: {{unidades}}\nInicio del servicio: {{fechaInicioServicio}}';

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
    codigo: 'pumping_asignacion_conductor',
    descripcion:
      'El Jefe de Base asignó a un Conductor a una unidad de un servicio de Pumping (solo a la cuenta elegida).',
    asunto: 'Fue asignado como conductor del servicio {{pedidoCodigo}} — {{cliente}}',
    cuerpoHtml:
      '<p>Hola {{nombre}},</p>' +
      '<p>{{asignadoPor}} lo asignó como <strong>Conductor</strong> del siguiente servicio de Pumping:</p>' +
      DATOS_ASIGNACION +
      '<p>Debe realizar la inspección de su unidad y solicitar su Gerenciamiento de Viaje. Su supervisor es <strong>{{supervisor}}</strong>.</p>',
    cuerpoTexto:
      'Hola {{nombre}},\n\n{{asignadoPor}} lo asignó como Conductor del siguiente servicio de Pumping:\n\n' +
      TEXTO_ASIGNACION +
      '\n\nDebe realizar la inspección de su unidad y solicitar su Gerenciamiento de Viaje. Su supervisor es {{supervisor}}.',
    tituloAviso: 'Asignado como conductor: {{pedidoCodigo}}',
    detalleAviso: '{{cliente}} · Pozo {{pozo}} · Unidades {{unidades}}',
    enlaceAviso: '/modulos/operativo/pumping/pedidos/{{ticketId}}',
    tono: 'info',
    evento: 'operaciones.pumping.asignacion_realizada',
    rol: 'conductor',
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
  {
    codigo: 'pumping_inspeccion_realizada_supervisor',
    descripcion:
      'El operador realizó la inspección del vehículo: el Supervisor asignado debe aprobarla (solo a su cuenta).',
    asunto:
      'Inspección de vehículo realizada, pendiente de su aprobación: {{pedidoCodigo}} — {{cliente}}',
    cuerpoHtml:
      '<p>Hola {{nombre}},</p>' +
      '<p>{{realizadaPor}} realizó la <strong>inspección del vehículo</strong> de la unidad <strong>{{unidad}}</strong> del siguiente servicio de Pumping. Queda pendiente de su aprobación:</p>' +
      '<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;margin:8px 0 16px">' +
      FILA('Ticket', 'ticketNumero') +
      FILA('Pedido', 'pedidoCodigo') +
      FILA('Cliente', 'cliente') +
      FILA('Campo', 'campo') +
      FILA('Pozo', 'pozo') +
      FILA('Taladro', 'taladro') +
      FILA('Unidad', 'unidad') +
      '</table>' +
      '<p>Revise y apruebe la inspección desde el ticket; el servicio no puede pasar a la ejecución sin una inspección aprobada.</p>',
    cuerpoTexto:
      'Hola {{nombre}},\n\n{{realizadaPor}} realizó la inspección del vehículo de la unidad {{unidad}} del siguiente servicio de Pumping. Queda pendiente de su aprobación:\n\n' +
      'Ticket: {{ticketNumero}}\nPedido: {{pedidoCodigo}}\nCliente: {{cliente}}\nCampo: {{campo}}\nPozo: {{pozo}}\nTaladro: {{taladro}}\nUnidad: {{unidad}}\n\n' +
      'Revise y apruebe la inspección desde el ticket; el servicio no puede pasar a la ejecución sin una inspección aprobada.',
    tituloAviso: 'Inspección por aprobar: {{unidad}}',
    detalleAviso: '{{cliente}} · Pozo {{pozo}} — {{realizadaPor}} realizó la inspección',
    enlaceAviso: '/modulos/operativo/pumping/pedidos/{{ticketId}}',
    tono: 'info',
    evento: 'operaciones.pumping.inspeccion_realizada',
    rol: 'supervisor',
  },
  {
    codigo: 'pumping_avance_adelantado_jefe_base',
    descripcion:
      'El avance real de un servicio de Pumping va adelantado del plan: el Jefe de Base decide si acorta la duración (una vez por servicio).',
    asunto: 'El servicio va adelantado: {{pedidoCodigo}} — {{cliente}}',
    cuerpoHtml:
      '<p>Hola {{nombre}},</p>' +
      '<p>Como <strong>{{cargo}}</strong>, debe saber que el servicio del pedido <strong>{{pedidoCodigo}}</strong> <strong>va adelantado</strong>: lleva {{avanceReal}} % de lo cotizado y ya pasó el día {{diaActual}} de {{diasTotal}} (el plan era {{avancePlan}} %).</p>' +
      '<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;margin:8px 0 16px">' +
      FILA('Ticket', 'ticketNumero') +
      FILA('Pedido', 'pedidoCodigo') +
      FILA('Cliente', 'cliente') +
      FILA('Pozo', 'pozo') +
      FILA('Avance real', 'avanceReal') +
      FILA('Avance planificado', 'avancePlan') +
      '</table>' +
      '<p>Revise el avance en el ticket y decida si <strong>acorta la duración</strong> del servicio (si cambia lo cotizado, también puede modificar la cotización).</p>',
    cuerpoTexto:
      'Hola {{nombre}},\n\nComo {{cargo}}, debe saber que el servicio del pedido {{pedidoCodigo}} va adelantado: lleva {{avanceReal}} % de lo cotizado y ya pasó el día {{diaActual}} de {{diasTotal}} (el plan era {{avancePlan}} %).\n\n' +
      'Ticket: {{ticketNumero}}\nPedido: {{pedidoCodigo}}\nCliente: {{cliente}}\nPozo: {{pozo}}\nAvance real: {{avanceReal}}\nAvance planificado: {{avancePlan}}\n\n' +
      'Revise el avance en el ticket y decida si acorta la duración del servicio (si cambia lo cotizado, también puede modificar la cotización).',
    tituloAviso: 'El servicio va adelantado: {{pedidoCodigo}}',
    detalleAviso:
      '{{cliente}} · Pozo {{pozo}} — {{avanceReal}} % real frente a {{avancePlan}} % planificado',
    enlaceAviso: '/modulos/operativo/pumping/pedidos/{{ticketId}}',
    tono: 'warning',
    evento: 'operaciones.pumping.avance_adelantado',
    rol: 'jefe_base',
  },
  {
    codigo: 'pumping_jornada_sin_cerrar_supervisor',
    descripcion:
      'Pasó un día de servicio y su jornada sigue sin cerrar: se avisa una vez al Supervisor del ticket (solo a su cuenta).',
    asunto: 'Jornada sin cerrar: Ticket {{ticketNumero}} — día {{dia}}',
    cuerpoHtml:
      '<p>Hola {{nombre}},</p>' +
      '<p>La <strong>jornada del {{dia}}</strong> (día {{numero}} del servicio) del siguiente ticket sigue <strong>sin cerrar</strong>:</p>' +
      '<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;margin:8px 0 16px">' +
      FILA('Ticket', 'ticketNumero') +
      FILA('Pedido', 'pedidoCodigo') +
      FILA('Cliente', 'cliente') +
      FILA('Pozo', 'pozo') +
      FILA('Falta', 'faltan') +
      '</table>' +
      '<p>Mientras haya jornadas sin cerrar el ticket no puede salir de la Ejecución operativa. Complete lo que falta o regístrela como día sin operación.</p>',
    cuerpoTexto:
      'Hola {{nombre}},\n\nLa jornada del {{dia}} (día {{numero}} del servicio) del siguiente ticket sigue sin cerrar:\n\n' +
      'Ticket: {{ticketNumero}}\nPedido: {{pedidoCodigo}}\nCliente: {{cliente}}\nPozo: {{pozo}}\nFalta: {{faltan}}\n\n' +
      'Mientras haya jornadas sin cerrar el ticket no puede salir de la Ejecución operativa. Complete lo que falta o regístrela como día sin operación.',
    tituloAviso: 'Jornada del {{dia}} sin cerrar: Ticket {{ticketNumero}}',
    detalleAviso: '{{cliente}} · Pozo {{pozo}} — falta: {{faltan}}',
    enlaceAviso: '/modulos/operativo/pumping/pedidos/{{ticketId}}',
    tono: 'warning',
    evento: 'operaciones.pumping.jornada_sin_cerrar',
    rol: 'supervisor',
  },
  {
    codigo: 'pumping_jornada_sin_cerrar_operador',
    descripcion:
      'Pasó un día de servicio y su jornada sigue sin cerrar: se avisa una vez al Operador del ticket (solo a su cuenta).',
    asunto: 'Jornada sin cerrar: Ticket {{ticketNumero}} — día {{dia}}',
    cuerpoHtml:
      '<p>Hola {{nombre}},</p>' +
      '<p>La <strong>jornada del {{dia}}</strong> (día {{numero}} del servicio) del siguiente ticket sigue <strong>sin cerrar</strong>:</p>' +
      '<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;margin:8px 0 16px">' +
      FILA('Ticket', 'ticketNumero') +
      FILA('Pedido', 'pedidoCodigo') +
      FILA('Cliente', 'cliente') +
      FILA('Pozo', 'pozo') +
      FILA('Falta', 'faltan') +
      '</table>' +
      '<p>Mientras haya jornadas sin cerrar el ticket no puede salir de la Ejecución operativa. Complete lo que falta o regístrela como día sin operación.</p>',
    cuerpoTexto:
      'Hola {{nombre}},\n\nLa jornada del {{dia}} (día {{numero}} del servicio) del siguiente ticket sigue sin cerrar:\n\n' +
      'Ticket: {{ticketNumero}}\nPedido: {{pedidoCodigo}}\nCliente: {{cliente}}\nPozo: {{pozo}}\nFalta: {{faltan}}\n\n' +
      'Mientras haya jornadas sin cerrar el ticket no puede salir de la Ejecución operativa. Complete lo que falta o regístrela como día sin operación.',
    tituloAviso: 'Jornada del {{dia}} sin cerrar: Ticket {{ticketNumero}}',
    detalleAviso: '{{cliente}} · Pozo {{pozo}} — falta: {{faltan}}',
    enlaceAviso: '/modulos/operativo/pumping/pedidos/{{ticketId}}',
    tono: 'warning',
    evento: 'operaciones.pumping.jornada_sin_cerrar',
    rol: 'operador',
  },
  {
    codigo: 'pumping_requisito_vencido',
    descripcion:
      'Un requisito de un ticket de Pumping venció sin cumplirse: se avisa a las cuentas de `asignados` o, si viene vacío (p. ej. QHSE), a todas las cuentas activas con el rol responsable del requisito.',
    asunto: 'Requisito vencido: {{requisito}} — Ticket {{ticketNumero}}',
    cuerpoHtml:
      '<p>Hola {{nombre}},</p>' +
      '<p>El requisito <strong>{{requisito}}</strong> del siguiente ticket de Pumping está <strong>vencido</strong> y sigue sin cumplirse:</p>' +
      '<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;margin:8px 0 16px">' +
      FILA('Requisito', 'requisito') +
      FILA('Ticket', 'ticketNumero') +
      FILA('Pedido', 'pedidoCodigo') +
      FILA('Cliente', 'cliente') +
      FILA('Pozo', 'pozo') +
      FILA('Para', 'para') +
      FILA('Día', 'dia') +
      FILA('Día del servicio', 'numero') +
      '</table>' +
      '<p>Cúmplalo cuanto antes desde el ticket: mientras esté vencido puede impedir que el servicio avance.</p>',
    cuerpoTexto:
      'Hola {{nombre}},\n\nEl requisito {{requisito}} del siguiente ticket de Pumping está vencido y sigue sin cumplirse:\n\n' +
      'Requisito: {{requisito}}\nTicket: {{ticketNumero}}\nPedido: {{pedidoCodigo}}\nCliente: {{cliente}}\nPozo: {{pozo}}\nPara: {{para}}\nDía: {{dia}}\nDía del servicio: {{numero}}\n\n' +
      'Cúmplalo cuanto antes desde el ticket: mientras esté vencido puede impedir que el servicio avance.',
    tituloAviso: 'Requisito vencido: {{requisito}}',
    detalleAviso: 'Ticket {{ticketNumero}} · {{cliente}} · Pozo {{pozo}} — día {{dia}}',
    enlaceAviso: '/modulos/operativo/pumping/pedidos/{{ticketId}}',
    tono: 'error',
    evento: 'operaciones.pumping.requisito_vencido',
    rol: ROL_DEL_EVENTO,
    rolDesdeCampo: 'rolResponsable',
  },
  ...(['supervisor', 'operador', 'conductor'] as const).map((rol): PlantillaDef => ({
    codigo: `pumping_ticket_anulado_${rol}`,
    descripcion: `Un ticket de Pumping fue anulado: se avisa a quien estaba asignado como ${rol} (solo a su cuenta).`,
    asunto: 'Ticket anulado: {{ticketNumero}} — {{cliente}}',
    cuerpoHtml:
      '<p>Hola {{nombre}},</p>' +
      '<p>El ticket <strong>{{ticketNumero}}</strong> (pedido {{pedidoCodigo}}, {{cliente}}, pozo {{pozo}}) fue <strong>anulado</strong>. Queda libre de este servicio.</p>' +
      '<p><strong>Motivo:</strong> {{motivo}}</p>',
    cuerpoTexto:
      'Hola {{nombre}},\n\nEl ticket {{ticketNumero}} (pedido {{pedidoCodigo}}, {{cliente}}, pozo {{pozo}}) fue anulado. Queda libre de este servicio.\n\nMotivo: {{motivo}}',
    tituloAviso: 'Ticket anulado: {{ticketNumero}}',
    detalleAviso: '{{cliente}} · Pozo {{pozo}} — {{motivo}}',
    enlaceAviso: '/modulos/operativo/pumping/pedidos/{{ticketId}}',
    tono: 'error',
    evento: 'operaciones.pumping.ticket_anulado',
    rol,
  })),
  {
    codigo: 'pumping_responsable_asignado_jefe_base',
    descripcion:
      'Se asignó a un Jefe de Base como responsable de un ticket de Pumping (solo a la cuenta del nuevo responsable).',
    asunto: 'Es el responsable del ticket {{ticketNumero}} — {{cliente}}',
    cuerpoHtml:
      '<p>Hola {{nombre}},</p>' +
      '<p>{{asignadoPor}} lo asignó como <strong>responsable</strong> del ticket <strong>{{ticketNumero}}</strong> (pedido {{pedidoCodigo}}, {{cliente}}, pozo {{pozo}}).</p>' +
      '<p><strong>Motivo:</strong> {{motivo}}</p>' +
      '<p>El ticket aparece ahora en su bandeja.</p>',
    cuerpoTexto:
      'Hola {{nombre}},\n\n{{asignadoPor}} lo asignó como responsable del ticket {{ticketNumero}} (pedido {{pedidoCodigo}}, {{cliente}}, pozo {{pozo}}).\n\n' +
      'Motivo: {{motivo}}\n\nEl ticket aparece ahora en su bandeja.',
    tituloAviso: 'Es responsable del ticket {{ticketNumero}}',
    detalleAviso: '{{cliente}} · Pozo {{pozo}} — asignado por {{asignadoPor}}',
    enlaceAviso: '/modulos/operativo/pumping/pedidos/{{ticketId}}',
    tono: 'info',
    evento: 'operaciones.pumping.responsable_asignado',
    rol: 'jefe_base',
  },
];
