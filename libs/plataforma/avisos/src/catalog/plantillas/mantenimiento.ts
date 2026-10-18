import { FILA, type PlantillaDef } from './tipos';

const tabla = (...filas: string[]) =>
  '<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;margin:8px 0 16px">' +
  filas.join('') +
  '</table>';

const ENLACE_JEFE = '/dashboard/mantenimiento';
const ENLACE_MIS_TAREAS = '/dashboard/mantenimiento/mis-tareas';
const ENLACE_PUMPING = '/modulos/operativo/pumping/pedidos';

const SUBORDEN = tabla(
  FILA('Sub-orden', 'subordenCodigo'),
  FILA('Orden', 'ordenCodigo'),
  FILA('Unidad', 'unidad'),
  FILA('Tipo', 'tipoNombre'),
);
const SUBORDEN_TEXTO =
  'Sub-orden: {{subordenCodigo}}\nOrden: {{ordenCodigo}}\nUnidad: {{unidad}}\nTipo: {{tipoNombre}}';

/** Un aviso con su plantilla de correo en HTML y en texto, sobre un cuerpo corto. */
function aviso(
  p: Omit<PlantillaDef, 'cuerpoHtml' | 'cuerpoTexto'> & {
    intro: string;
    datos: string;
    datosTexto: string;
    cierre: string;
  },
): PlantillaDef {
  const { intro, datos, datosTexto, cierre, ...resto } = p;
  return {
    ...resto,
    cuerpoHtml: `<p>Hola {{nombre}},</p><p>${intro}</p>${datos}<p>${cierre}</p>`,
    cuerpoTexto: `Hola {{nombre}},\n\n${intro.replace(/<[^>]+>/g, '')}\n\n${datosTexto}\n\n${cierre.replace(/<[^>]+>/g, '')}`,
  };
}

/**
 * Plantillas del módulo Mantenimiento. Las que traen `asignados` en el evento (sub-orden asignada, corrección solicitada) llegan solo a la
 * cuenta del operador elegido; las demás, a todas las cuentas activas del rol. Los textos no llevan nombres de personas: unidad y códigos.
 */
export const PLANTILLAS_MANTENIMIENTO: PlantillaDef[] = [
  aviso({
    codigo: 'mantenimiento_reporte_recibido_jefe',
    descripcion:
      'Llegó un reporte de unidad con novedades: el Jefe de Mantenimiento debe clasificarlo.',
    asunto: 'Reporte de unidad por clasificar: {{codigo}} — {{unidad}}',
    intro:
      'Como <strong>{{cargo}}</strong>, tiene un reporte de unidad con novedades por clasificar:',
    datos: tabla(
      FILA('Reporte', 'codigo'),
      FILA('Unidad', 'unidad'),
      FILA('Origen', 'origen'),
      FILA('Ticket', 'ticketNumero'),
    ),
    datosTexto:
      'Reporte: {{codigo}}\nUnidad: {{unidad}}\nOrigen: {{origen}}\nTicket: {{ticketNumero}}',
    cierre:
      'Decida si requiere mantenimiento: descártelo con su motivo o genere la orden con sus sub-órdenes.',
    tituloAviso: 'Reporte por clasificar: {{codigo}}',
    detalleAviso: 'Unidad {{unidad}} · {{origen}}',
    enlaceAviso: ENLACE_JEFE,
    tono: 'warning',
    evento: 'operaciones.mantenimiento.reporte.recibido',
    rol: 'jefe_mantenimiento',
  }),
  aviso({
    codigo: 'mantenimiento_suborden_asignada_operador',
    descripcion:
      'El Jefe de Mantenimiento asignó una sub-orden al operador (solo a la cuenta elegida).',
    asunto: 'Se le asignó la sub-orden {{subordenCodigo}} — unidad {{unidad}}',
    intro: 'Se le asignó una sub-orden de mantenimiento <strong>{{tipoNombre}}</strong>:',
    datos: SUBORDEN,
    datosTexto: SUBORDEN_TEXTO,
    cierre: 'Haga el diagnóstico y la ejecución, y envíela a revisión cuando termine.',
    tituloAviso: 'Sub-orden asignada: {{subordenCodigo}}',
    detalleAviso: 'Unidad {{unidad}} · {{tipoNombre}}',
    enlaceAviso: ENLACE_MIS_TAREAS,
    tono: 'info',
    evento: 'operaciones.mantenimiento.suborden.asignada',
    rol: 'operador_mantenimiento',
  }),
  ...(['supervisor_pumping', 'supervisor'] as const).map((rol) =>
    aviso({
      codigo: `mantenimiento_suborden_derivada_${rol}`,
      descripcion:
        'Una sub-orden operativa se derivó a Pumping: la atiende el equipo operativo y la revisa el Supervisor.',
      asunto: 'Mantenimiento operativo derivado a Pumping: {{subordenCodigo}} — unidad {{unidad}}',
      intro:
        'Como <strong>{{cargo}}</strong>, tiene una sub-orden de mantenimiento operativo derivada a Pumping:',
      datos: SUBORDEN,
      datosTexto: SUBORDEN_TEXTO,
      cierre: 'La atiende el operador de la unidad desde el ticket y usted revisa su cierre.',
      tituloAviso: 'Mantenimiento operativo derivado: {{subordenCodigo}}',
      detalleAviso: 'Unidad {{unidad}}',
      enlaceAviso: ENLACE_PUMPING,
      tono: 'warning',
      evento: 'operaciones.mantenimiento.suborden.derivada_a_pumping',
      rol,
    }),
  ),
  aviso({
    codigo: 'mantenimiento_suborden_a_revision_jefe',
    descripcion:
      'El operador envió una sub-orden a revisión de cierre: el Jefe de Mantenimiento debe aprobarla o pedir una corrección.',
    asunto: 'Sub-orden por revisar: {{subordenCodigo}} — unidad {{unidad}}',
    intro:
      'Como <strong>{{cargo}}</strong>, tiene una sub-orden en <strong>revisión de cierre</strong>:',
    datos: SUBORDEN,
    datosTexto: SUBORDEN_TEXTO,
    cierre:
      'Apruebe el cierre o pida una corrección con su nota. Al aprobar, los repuestos del catálogo salen de bodega.',
    tituloAviso: 'Sub-orden por revisar: {{subordenCodigo}}',
    detalleAviso: 'Unidad {{unidad}} · {{tipoNombre}}',
    enlaceAviso: ENLACE_JEFE,
    tono: 'warning',
    evento: 'operaciones.mantenimiento.suborden.enviada_a_revision',
    rol: 'jefe_mantenimiento',
  }),
  aviso({
    codigo: 'mantenimiento_suborden_correccion_operador',
    descripcion:
      'El Jefe de Mantenimiento pidió una corrección: vuelve al operador asignado (solo a esa cuenta).',
    asunto: 'Corrección solicitada en la sub-orden {{subordenCodigo}} — unidad {{unidad}}',
    intro: 'El Jefe de Mantenimiento <strong>solicitó una corrección</strong> en su sub-orden:',
    datos: SUBORDEN,
    datosTexto: SUBORDEN_TEXTO,
    cierre: 'Revise la nota de la corrección, ajuste el avance y vuelva a enviarla a revisión.',
    tituloAviso: 'Corrección solicitada: {{subordenCodigo}}',
    detalleAviso: 'Unidad {{unidad}} · {{tipoNombre}}',
    enlaceAviso: ENLACE_MIS_TAREAS,
    tono: 'error',
    evento: 'operaciones.mantenimiento.suborden.correccion_solicitada',
    rol: 'operador_mantenimiento',
  }),
  aviso({
    codigo: 'mantenimiento_orden_aceptada_jefe',
    descripcion:
      'Todas las sub-órdenes de la orden están resueltas: el Jefe de Mantenimiento ya puede devolver la unidad a operación.',
    asunto: 'Orden lista para devolver la unidad: {{ordenCodigo}} — {{unidad}}',
    intro:
      'Como <strong>{{cargo}}</strong>, la siguiente orden quedó <strong>aceptada</strong>: todas sus sub-órdenes están cerradas o derivadas.',
    datos: tabla(FILA('Orden', 'ordenCodigo'), FILA('Unidad', 'unidad')),
    datosTexto: 'Orden: {{ordenCodigo}}\nUnidad: {{unidad}}',
    cierre:
      'Devuelva la unidad a Operaciones indicando su estado final (disponible o con restricciones).',
    tituloAviso: 'Orden aceptada: {{ordenCodigo}}',
    detalleAviso: 'Unidad {{unidad}} — lista para devolver a operación',
    enlaceAviso: ENLACE_JEFE,
    tono: 'info',
    evento: 'operaciones.mantenimiento.orden.aceptada',
    rol: 'jefe_mantenimiento',
  }),
  aviso({
    codigo: 'mantenimiento_unidad_retornada_jefe_base',
    descripcion:
      'Mantenimiento devolvió la unidad a operación: el Jefe de Base ya puede asignarla.',
    asunto: 'Unidad devuelta a operación: {{unidad}} ({{estadoFinalNombre}})',
    intro: 'Mantenimiento devolvió una unidad a operación:',
    datos: tabla(
      FILA('Unidad', 'unidad'),
      FILA('Orden', 'ordenCodigo'),
      FILA('Estado final', 'estadoFinalNombre'),
    ),
    datosTexto: 'Unidad: {{unidad}}\nOrden: {{ordenCodigo}}\nEstado final: {{estadoFinalNombre}}',
    cierre:
      'Si queda con restricciones, tenga presente sus observaciones antes de asignarla a un servicio.',
    tituloAviso: 'Unidad devuelta: {{unidad}}',
    detalleAviso: '{{estadoFinalNombre}} · orden {{ordenCodigo}}',
    enlaceAviso: ENLACE_PUMPING,
    tono: 'info',
    evento: 'operaciones.mantenimiento.orden.retornada',
    rol: 'jefe_base',
  }),
];
