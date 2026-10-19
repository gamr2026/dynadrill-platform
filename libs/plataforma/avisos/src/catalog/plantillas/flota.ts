import { FILA, type PlantillaDef } from './tipos';

const tabla = (...filas: string[]) =>
  '<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;margin:8px 0 16px">' +
  filas.join('') +
  '</table>';

const ENLACE_VIAJES = '/dashboard/flota/viajes';
const ENLACE_INSPECCIONES = '/dashboard/flota/inspecciones';

/**
 * Gerenciamiento de viaje por autorizar. El evento ya dice a quién le toca según el nivel de riesgo (`por_autorizar_supervisor` o
 * `por_autorizar_gerente`, que Flota elige con el permiso del umbral); aquí solo se liga cada evento con los roles que lo reciben.
 */
const porAutorizar = (
  evento: string,
  rol: string,
  sufijo: string,
  quien: string,
): PlantillaDef => ({
  codigo: `flota_viaje_por_autorizar_${sufijo}_${rol}`,
  descripcion: `Un conductor solicitó un gerenciamiento de viaje que debe autorizar ${quien}.`,
  asunto: 'Gerenciamiento de viaje por autorizar: {{codigo}} — riesgo {{nivelTexto}}',
  cuerpoHtml:
    '<p>Hola {{nombre}},</p>' +
    '<p>Como <strong>{{cargo}}</strong>, tiene un gerenciamiento de viaje {{tipoTexto}} por autorizar:</p>' +
    tabla(
      FILA('Solicitud', 'codigo'),
      FILA('Riesgo', 'nivelTexto'),
      FILA('Puntaje', 'puntaje'),
      FILA('Conductor', 'conductor'),
      FILA('Unidad', 'unidad'),
      FILA('Fecha del viaje', 'fecha'),
    ) +
    '<p>Revise el cuestionario de riesgo y autorice o rechace la solicitud; el ticket no avanza sin esa autorización.</p>',
  cuerpoTexto:
    'Hola {{nombre}},\n\nComo {{cargo}}, tiene un gerenciamiento de viaje {{tipoTexto}} por autorizar:\n\nSolicitud: {{codigo}}\nRiesgo: {{nivelTexto}}\nPuntaje: {{puntaje}}\nConductor: {{conductor}}\nUnidad: {{unidad}}\nFecha del viaje: {{fecha}}\n\nRevise el cuestionario de riesgo y autorice o rechace la solicitud; el ticket no avanza sin esa autorización.',
  tituloAviso: 'Viaje por autorizar: {{codigo}}',
  detalleAviso: 'Riesgo {{nivelTexto}} · {{conductor}} · {{unidad}}',
  enlaceAviso: ENLACE_VIAJES,
  tono: 'warning',
  evento,
  rol,
});

/** Plantillas del módulo Flota. Los textos no llevan nombres de catálogo que otro módulo pueda obtener: unidad, códigos y la persona del viaje. */
export const PLANTILLAS_FLOTA: PlantillaDef[] = [
  porAutorizar(
    'flota.gerenciamiento_viaje.por_autorizar_supervisor',
    'supervisor_pumping',
    'supervisor',
    'el Supervisor',
  ),
  porAutorizar(
    'flota.gerenciamiento_viaje.por_autorizar_supervisor',
    'supervisor',
    'supervisor',
    'el Supervisor',
  ),
  porAutorizar(
    'flota.gerenciamiento_viaje.por_autorizar_gerente',
    'gerente_hse',
    'gerente',
    'un gerente',
  ),
  porAutorizar(
    'flota.gerenciamiento_viaje.por_autorizar_gerente',
    'jefe_base',
    'gerente',
    'un gerente',
  ),
  {
    codigo: 'flota_viaje_decidido_conductor',
    descripcion:
      'Se autorizó o se rechazó el gerenciamiento de viaje del conductor (solo a su cuenta).',
    asunto: 'Su gerenciamiento de viaje {{codigo}} fue {{resultado}}',
    cuerpoHtml:
      '<p>Hola {{nombre}},</p>' +
      '<p>Su gerenciamiento de viaje {{tipoTexto}} <strong>{{codigo}}</strong> fue <strong>{{resultado}}</strong>.{{motivoTexto}}</p>' +
      '<p>Si fue rechazado, corrija lo necesario y solicítelo de nuevo desde Flota.</p>',
    cuerpoTexto:
      'Hola {{nombre}},\n\nSu gerenciamiento de viaje {{tipoTexto}} {{codigo}} fue {{resultado}}.{{motivoTexto}}\n\nSi fue rechazado, corrija lo necesario y solicítelo de nuevo desde Flota.',
    tituloAviso: 'Viaje {{resultado}}: {{codigo}}',
    detalleAviso: 'Gerenciamiento de viaje {{tipoTexto}}.{{motivoTexto}}',
    enlaceAviso: ENLACE_VIAJES,
    tono: 'info',
    evento: 'flota.gerenciamiento_viaje.decidido',
    rol: 'conductor',
  },
  {
    codigo: 'flota_inspeccion_rechazada_conductor',
    descripcion:
      'El Supervisor rechazó la inspección de vehículo: el conductor debe repetirla (solo a su cuenta).',
    asunto: 'Inspección de vehículo rechazada — unidad {{unidadCodigo}}',
    cuerpoHtml:
      '<p>Hola {{nombre}},</p>' +
      '<p>El Supervisor rechazó la inspección de vehículo de la unidad <strong>{{unidadCodigo}}</strong>.</p>' +
      '<p>Motivo: {{motivoTexto}}</p>' +
      '<p>Repita la inspección (DYN-SGI-RE-068) desde Flota; el servicio no puede pasar a la ejecución sin una inspección aprobada.</p>',
    cuerpoTexto:
      'Hola {{nombre}},\n\nEl Supervisor rechazó la inspección de vehículo de la unidad {{unidadCodigo}}.\n\nMotivo: {{motivoTexto}}\n\nRepita la inspección (DYN-SGI-RE-068) desde Flota; el servicio no puede pasar a la ejecución sin una inspección aprobada.',
    tituloAviso: 'Inspección rechazada: {{unidadCodigo}}',
    detalleAviso: '{{motivoTexto}}',
    enlaceAviso: ENLACE_INSPECCIONES,
    tono: 'warning',
    evento: 'flota.inspeccion_vehiculo.rechazada',
    rol: 'conductor',
  },
];
