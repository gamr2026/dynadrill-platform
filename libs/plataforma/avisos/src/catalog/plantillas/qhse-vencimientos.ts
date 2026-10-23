import { FILA, type PlantillaDef } from './tipos';

/**
 * Avisos de QHSE por vencimientos y plazos (sesión S2) y de la investigación de incidentes. Los de vencimiento los emite el emisor programado de
 * QHSE como eventos `qhse.aviso.*` (uno por cada hecho: la clave evita avisar dos veces lo mismo); el texto, a quién y por dónde sale de aquí.
 * El aviso del límite de almacenamiento de desechos es de otra sesión y no está en este archivo.
 */

type RolHse = 'tecnico_hse' | 'gerente_hse';
const ROLES_HSE: readonly RolHse[] = ['tecnico_hse', 'gerente_hse'];

const TABLA = (filas: Array<[string, string]>) =>
  '<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;margin:8px 0 16px">' +
  filas.map(([etiqueta, variable]) => FILA(etiqueta, variable)).join('') +
  '</table>';
const LISTA = (filas: Array<[string, string]>) =>
  filas.map(([etiqueta, variable]) => `${etiqueta}: {{${variable}}}`).join('\n');

interface Definicion {
  /** Evento que dispara el aviso. */
  evento: string;
  /** Prefijo del código de plantilla (se le agrega el rol). */
  codigo: string;
  descripcion: string;
  asunto: string;
  /** Primer párrafo (HTML permitido) y su versión de texto; puede usar `{{cargo}}`. */
  intro: string;
  introTexto: string;
  filas: Array<[string, string]>;
  cierre?: string;
  cierreTexto?: string;
  titulo: string;
  detalle: string;
  enlace: string;
  tono: PlantillaDef['tono'];
  roles?: readonly string[];
}

/** Una plantilla por rol: cada (evento, rol) es una regla distinta del módulo de Avisos. */
function aPlantillas(d: Definicion): PlantillaDef[] {
  return (d.roles ?? ROLES_HSE).map((rol) => ({
    codigo: `${d.codigo}_${rol}`,
    descripcion: d.descripcion,
    asunto: d.asunto,
    cuerpoHtml:
      '<p>Hola {{nombre}},</p>' +
      `<p>${d.intro}</p>` +
      TABLA(d.filas) +
      (d.cierre ? `<p>${d.cierre}</p>` : ''),
    cuerpoTexto:
      `Hola {{nombre}},\n\n${d.introTexto}\n\n${LISTA(d.filas)}` +
      (d.cierreTexto ? `\n\n${d.cierreTexto}` : ''),
    tituloAviso: d.titulo,
    detalleAviso: d.detalle,
    enlaceAviso: d.enlace,
    tono: d.tono,
    evento: d.evento,
    rol,
  }));
}

const DEFINICIONES: Definicion[] = [
  // ---- ART de un pedido (vigencia legal de 15 días; avisa 3 días antes)
  {
    evento: 'qhse.aviso.art_por_vencer',
    codigo: 'qhse_art_por_vencer',
    descripcion: 'El ART de un pedido está por vencer (aviso 3 días antes).',
    asunto: 'ART por vencer: {{pedidoCodigo}} ({{vigenteHasta}})',
    intro:
      'Como <strong>{{cargo}}</strong>, debe saber que el <strong>ART</strong> del pedido <strong>{{pedidoCodigo}}</strong> vence el <strong>{{vigenteHasta}}</strong> (faltan {{diasParaVencer}} día(s)).',
    introTexto:
      'Como {{cargo}}, debe saber que el ART del pedido {{pedidoCodigo}} vence el {{vigenteHasta}} (faltan {{diasParaVencer}} día(s)).',
    filas: [
      ['Pedido', 'pedidoCodigo'],
      ['Cliente', 'cliente'],
      ['Campo', 'campo'],
      ['Pozo', 'pozo'],
    ],
    cierre:
      'Cargue el ART nuevo antes de que venza: con el ART vencido no se aprueba el PTW del día.',
    cierreTexto:
      'Cargue el ART nuevo antes de que venza: con el ART vencido no se aprueba el PTW del día.',
    titulo: 'ART por vencer: {{pedidoCodigo}}',
    detalle: 'Vence el {{vigenteHasta}} · {{cliente}}',
    enlace: '/dashboard/qhse/documentos',
    tono: 'warning',
  },
  {
    evento: 'qhse.aviso.art_vencido',
    codigo: 'qhse_art_vencido',
    descripcion: 'El ART de un pedido ya venció.',
    asunto: 'ART vencido: {{pedidoCodigo}} ({{vigenteHasta}})',
    intro:
      'Como <strong>{{cargo}}</strong>, debe saber que el <strong>ART</strong> del pedido <strong>{{pedidoCodigo}}</strong> venció el <strong>{{vigenteHasta}}</strong>.',
    introTexto:
      'Como {{cargo}}, debe saber que el ART del pedido {{pedidoCodigo}} venció el {{vigenteHasta}}.',
    filas: [
      ['Pedido', 'pedidoCodigo'],
      ['Cliente', 'cliente'],
      ['Campo', 'campo'],
      ['Pozo', 'pozo'],
    ],
    cierre: 'Cargue el ART nuevo: mientras esté vencido no se aprueba el PTW del día.',
    cierreTexto: 'Cargue el ART nuevo: mientras esté vencido no se aprueba el PTW del día.',
    titulo: 'ART vencido: {{pedidoCodigo}}',
    detalle: 'Venció el {{vigenteHasta}} · {{cliente}}',
    enlace: '/dashboard/qhse/documentos',
    tono: 'error',
  },

  // ---- Requisitos legales (la revisión vigente de la matriz de Ambiente o de SST)
  {
    evento: 'qhse.aviso.requisito_legal_por_vencer',
    codigo: 'qhse_requisito_legal_por_vencer',
    descripcion: 'La revisión vigente de una matriz de requisitos legales está por vencer.',
    asunto: 'Requisitos legales por vencer: {{tipoNombre}} ({{vigenteHasta}})',
    intro:
      'Como <strong>{{cargo}}</strong>, debe saber que la matriz de <strong>{{tipoNombre}}</strong> (revisión {{revision}}) vence el <strong>{{vigenteHasta}}</strong> (faltan {{diasParaVencer}} día(s)).',
    introTexto:
      'Como {{cargo}}, debe saber que la matriz de {{tipoNombre}} (revisión {{revision}}) vence el {{vigenteHasta}} (faltan {{diasParaVencer}} día(s)).',
    filas: [
      ['Matriz', 'tipoNombre'],
      ['Revisión', 'revision'],
      ['Vigente hasta', 'vigenteHasta'],
    ],
    cierre: 'Registre la revisión nueva con su documento antes de que venza.',
    cierreTexto: 'Registre la revisión nueva con su documento antes de que venza.',
    titulo: 'Requisitos legales por vencer',
    detalle: '{{tipoNombre}} · vence el {{vigenteHasta}}',
    enlace: '/dashboard/qhse/legal',
    tono: 'warning',
  },
  {
    evento: 'qhse.aviso.requisito_legal_vencido',
    codigo: 'qhse_requisito_legal_vencido',
    descripcion: 'La revisión vigente de una matriz de requisitos legales ya venció.',
    asunto: 'Requisitos legales vencidos: {{tipoNombre}} ({{vigenteHasta}})',
    intro:
      'Como <strong>{{cargo}}</strong>, debe saber que la matriz de <strong>{{tipoNombre}}</strong> (revisión {{revision}}) venció el <strong>{{vigenteHasta}}</strong>.',
    introTexto:
      'Como {{cargo}}, debe saber que la matriz de {{tipoNombre}} (revisión {{revision}}) venció el {{vigenteHasta}}.',
    filas: [
      ['Matriz', 'tipoNombre'],
      ['Revisión', 'revision'],
      ['Venció el', 'vigenteHasta'],
    ],
    cierre: 'Registre la revisión nueva con su documento.',
    cierreTexto: 'Registre la revisión nueva con su documento.',
    titulo: 'Requisitos legales vencidos',
    detalle: '{{tipoNombre}} · venció el {{vigenteHasta}}',
    enlace: '/dashboard/qhse/legal',
    tono: 'error',
  },

  // ---- Inspecciones de campo con la vigencia vencida
  {
    evento: 'qhse.aviso.inspeccion_vencida',
    codigo: 'qhse_inspeccion_vencida',
    descripcion:
      'La vigencia de la última inspección de un equipo venció: corresponde una inspección nueva.',
    asunto: 'Inspección vencida: {{tipoNombre}} {{equipoCodigo}} ({{vigenteHasta}})',
    intro:
      'Como <strong>{{cargo}}</strong>, debe saber que la última inspección <strong>{{codigo}}</strong> del equipo <strong>{{equipoCodigo}}</strong> ({{tipoNombre}}) venció el <strong>{{vigenteHasta}}</strong>.',
    introTexto:
      'Como {{cargo}}, debe saber que la última inspección {{codigo}} del equipo {{equipoCodigo}} ({{tipoNombre}}) venció el {{vigenteHasta}}.',
    filas: [
      ['Equipo', 'equipoCodigo'],
      ['Tipo', 'tipoNombre'],
      ['Inspección', 'codigo'],
      ['Venció el', 'vigenteHasta'],
    ],
    cierre: 'Programe una inspección nueva del equipo.',
    cierreTexto: 'Programe una inspección nueva del equipo.',
    titulo: 'Inspección vencida: {{equipoCodigo}}',
    detalle: '{{tipoNombre}} · venció el {{vigenteHasta}}',
    enlace: '/dashboard/qhse/inspecciones',
    tono: 'warning',
  },

  // ---- Plazos de la investigación de incidentes
  {
    evento: 'qhse.aviso.investigacion_inicio_vencido',
    codigo: 'qhse_investigacion_inicio_vencido',
    descripcion:
      'Venció el plazo para asegurar la escena e iniciar una investigación que sigue sin iniciarse.',
    asunto: 'Investigación sin iniciar: {{codigo}} ({{resultadoNombre}})',
    intro:
      'Como <strong>{{cargo}}</strong>, debe saber que la investigación <strong>{{codigo}}</strong> sigue sin iniciarse y su plazo para hacerlo venció el <strong>{{limite}}</strong>.',
    introTexto:
      'Como {{cargo}}, debe saber que la investigación {{codigo}} sigue sin iniciarse y su plazo para hacerlo venció el {{limite}}.',
    filas: [
      ['Investigación', 'codigo'],
      ['Resultado', 'resultadoNombre'],
      ['Ubicación', 'ubicacion'],
      ['Plazo de inicio', 'limite'],
    ],
    cierre: 'Asegure la escena y nombre al líder de la investigación.',
    cierreTexto: 'Asegure la escena y nombre al líder de la investigación.',
    titulo: 'Investigación sin iniciar: {{codigo}}',
    detalle: '{{resultadoNombre}} · {{ubicacion}}',
    enlace: '/dashboard/qhse/investigaciones',
    tono: 'error',
  },
  {
    evento: 'qhse.aviso.investigacion_final_por_vencer',
    codigo: 'qhse_investigacion_final_por_vencer',
    descripcion: 'El plazo del informe final de una investigación está por vencer.',
    asunto: 'Informe de investigación por vencer: {{codigo}} ({{limite}})',
    intro:
      'Como <strong>{{cargo}}</strong>, debe saber que el informe final de la investigación <strong>{{codigo}}</strong> vence el <strong>{{limite}}</strong> (faltan {{diasParaVencer}} día(s)).',
    introTexto:
      'Como {{cargo}}, debe saber que el informe final de la investigación {{codigo}} vence el {{limite}} (faltan {{diasParaVencer}} día(s)).',
    filas: [
      ['Investigación', 'codigo'],
      ['Resultado', 'resultadoNombre'],
      ['Ubicación', 'ubicacion'],
      ['Plazo del informe', 'limite'],
    ],
    cierre: 'Complete el análisis y envíe el informe a revisión.',
    cierreTexto: 'Complete el análisis y envíe el informe a revisión.',
    titulo: 'Informe por vencer: {{codigo}}',
    detalle: 'Vence el {{limite}} · {{resultadoNombre}}',
    enlace: '/dashboard/qhse/investigaciones',
    tono: 'warning',
  },
  {
    evento: 'qhse.aviso.investigacion_final_vencido',
    codigo: 'qhse_investigacion_final_vencido',
    descripcion: 'Venció el plazo del informe final de una investigación que sigue abierta.',
    asunto: 'Informe de investigación vencido: {{codigo}} ({{limite}})',
    intro:
      'Como <strong>{{cargo}}</strong>, debe saber que el informe final de la investigación <strong>{{codigo}}</strong> venció el <strong>{{limite}}</strong> y la investigación sigue abierta.',
    introTexto:
      'Como {{cargo}}, debe saber que el informe final de la investigación {{codigo}} venció el {{limite}} y la investigación sigue abierta.',
    filas: [
      ['Investigación', 'codigo'],
      ['Resultado', 'resultadoNombre'],
      ['Ubicación', 'ubicacion'],
      ['Venció el', 'limite'],
    ],
    cierre: 'Complete el análisis y cierre la investigación.',
    cierreTexto: 'Complete el análisis y cierre la investigación.',
    titulo: 'Informe vencido: {{codigo}}',
    detalle: 'Venció el {{limite}} · {{resultadoNombre}}',
    enlace: '/dashboard/qhse/investigaciones',
    tono: 'error',
  },
  {
    evento: 'qhse.aviso.accion_investigacion_vencida',
    codigo: 'qhse_accion_investigacion_vencida',
    descripcion:
      'Una acción correctiva o preventiva de una investigación pasó su plazo sin implementarse.',
    asunto: 'Acción vencida: {{investigacionCodigo}} · acción {{orden}}',
    intro:
      'Como <strong>{{cargo}}</strong>, debe saber que la acción {{orden}} de la investigación <strong>{{investigacionCodigo}}</strong> pasó su plazo ({{plazo}}) sin implementarse.',
    introTexto:
      'Como {{cargo}}, debe saber que la acción {{orden}} de la investigación {{investigacionCodigo}} pasó su plazo ({{plazo}}) sin implementarse.',
    filas: [
      ['Investigación', 'investigacionCodigo'],
      ['Acción', 'descripcion'],
      ['Responsable', 'responsable'],
      ['Plazo', 'plazo'],
    ],
    titulo: 'Acción vencida: {{investigacionCodigo}}',
    detalle: '{{descripcion}} · {{responsable}}',
    enlace: '/dashboard/qhse/investigaciones',
    tono: 'warning',
  },
  {
    // la persona responsable de la acción (el evento trae `asignados` con ella): no se mezcla con el aviso del equipo HSE
    evento: 'qhse.aviso.accion_investigacion_vencida_responsable',
    codigo: 'qhse_accion_investigacion_vencida',
    descripcion: 'Avisa a quien debe implementar una acción de investigación que ya pasó su plazo.',
    asunto: 'Su acción de investigación está vencida: {{investigacionCodigo}} · acción {{orden}}',
    intro:
      'Usted es responsable de la acción {{orden}} de la investigación <strong>{{investigacionCodigo}}</strong> y su plazo ({{plazo}}) ya pasó sin que se implemente.',
    introTexto:
      'Usted es responsable de la acción {{orden}} de la investigación {{investigacionCodigo}} y su plazo ({{plazo}}) ya pasó sin que se implemente.',
    filas: [
      ['Investigación', 'investigacionCodigo'],
      ['Acción', 'descripcion'],
      ['Plazo', 'plazo'],
    ],
    cierre: 'Implemente la acción y avise a QHSE para que la registre.',
    cierreTexto: 'Implemente la acción y avise a QHSE para que la registre.',
    titulo: 'Su acción está vencida: {{investigacionCodigo}}',
    detalle: '{{descripcion}} · plazo {{plazo}}',
    enlace: '/dashboard/qhse/investigaciones',
    tono: 'warning',
    roles: ['responsable_accion'],
  },

  // ---- Gestión ambiental
  {
    evento: 'qhse.aviso.objetivo_ambiental_por_vencer',
    codigo: 'qhse_objetivo_ambiental_por_vencer',
    descripcion: 'Un objetivo ambiental en curso está por llegar a su plazo.',
    asunto: 'Objetivo ambiental por vencer: {{codigo}} ({{plazo}})',
    intro:
      'Como <strong>{{cargo}}</strong>, debe saber que el objetivo ambiental <strong>{{codigo}}</strong> ({{titulo}}) vence el <strong>{{plazo}}</strong> (faltan {{diasParaVencer}} día(s)).',
    introTexto:
      'Como {{cargo}}, debe saber que el objetivo ambiental {{codigo}} ({{titulo}}) vence el {{plazo}} (faltan {{diasParaVencer}} día(s)).',
    filas: [
      ['Objetivo', 'codigo'],
      ['Título', 'titulo'],
      ['Plazo', 'plazo'],
    ],
    cierre: 'Registre su seguimiento y ciérrelo como cumplido o no cumplido.',
    cierreTexto: 'Registre su seguimiento y ciérrelo como cumplido o no cumplido.',
    titulo: 'Objetivo por vencer: {{codigo}}',
    detalle: '{{titulo}} · vence el {{plazo}}',
    enlace: '/dashboard/qhse/objetivos-ambientales',
    tono: 'warning',
  },
  {
    evento: 'qhse.aviso.objetivo_ambiental_vencido',
    codigo: 'qhse_objetivo_ambiental_vencido',
    descripcion: 'Un objetivo ambiental sigue en curso y su plazo ya pasó.',
    asunto: 'Objetivo ambiental vencido: {{codigo}} ({{plazo}})',
    intro:
      'Como <strong>{{cargo}}</strong>, debe saber que el objetivo ambiental <strong>{{codigo}}</strong> ({{titulo}}) venció el <strong>{{plazo}}</strong> y sigue en curso.',
    introTexto:
      'Como {{cargo}}, debe saber que el objetivo ambiental {{codigo}} ({{titulo}}) venció el {{plazo}} y sigue en curso.',
    filas: [
      ['Objetivo', 'codigo'],
      ['Título', 'titulo'],
      ['Venció el', 'plazo'],
    ],
    cierre: 'Ciérrelo como cumplido o no cumplido, con su resultado.',
    cierreTexto: 'Ciérrelo como cumplido o no cumplido, con su resultado.',
    titulo: 'Objetivo vencido: {{codigo}}',
    detalle: '{{titulo}} · venció el {{plazo}}',
    enlace: '/dashboard/qhse/objetivos-ambientales',
    tono: 'error',
  },
  {
    evento: 'qhse.aviso.control_ambiental_vencido',
    codigo: 'qhse_control_ambiental_vencido',
    descripcion: 'El control de un aspecto ambiental no se implementó y su plazo ya pasó.',
    asunto: 'Control ambiental vencido: {{codigo}} ({{plazo}})',
    intro:
      'Como <strong>{{cargo}}</strong>, debe saber que el control del aspecto ambiental <strong>{{codigo}}</strong> venció el <strong>{{plazo}}</strong> sin implementarse.',
    introTexto:
      'Como {{cargo}}, debe saber que el control del aspecto ambiental {{codigo}} venció el {{plazo}} sin implementarse.',
    filas: [
      ['Aspecto', 'codigo'],
      ['Actividad', 'actividad'],
      ['Clasificación', 'clasificacion'],
      ['Venció el', 'plazo'],
    ],
    cierre: 'Actualice el estado del control o registre su seguimiento.',
    cierreTexto: 'Actualice el estado del control o registre su seguimiento.',
    titulo: 'Control ambiental vencido: {{codigo}}',
    detalle: '{{actividad}} · venció el {{plazo}}',
    enlace: '/dashboard/qhse/aspectos-ambientales',
    tono: 'warning',
  },

  // ---- Ciclo de la investigación (eventos del propio flujo, no de un vencimiento)
  {
    evento: 'qhse.investigacion.abierta',
    codigo: 'qhse_investigacion_abierta',
    descripcion:
      'Se abrió una investigación de incidente: el equipo HSE debe asegurar la escena y nombrar al líder.',
    asunto: 'Investigación abierta: {{codigo}} ({{resultadoNombre}})',
    intro:
      'Como <strong>{{cargo}}</strong>, se abrió la investigación <strong>{{codigo}}</strong>: <strong>{{resultadoNombre}}</strong>. Asegure la escena y nombre al líder antes del <strong>{{inicioLimite}}</strong>.',
    introTexto:
      'Como {{cargo}}, se abrió la investigación {{codigo}}: {{resultadoNombre}}. Asegure la escena y nombre al líder antes del {{inicioLimite}}.',
    filas: [
      ['Investigación', 'codigo'],
      ['Resultado', 'resultadoNombre'],
      ['Ubicación', 'ubicacion'],
      ['Informe final hasta', 'finalLimite'],
    ],
    titulo: 'Investigación abierta: {{codigo}}',
    detalle: '{{resultadoNombre}} · {{ubicacion}}',
    enlace: '/dashboard/qhse/investigaciones',
    tono: 'warning',
  },
  {
    evento: 'qhse.investigacion.enviada_a_revision',
    codigo: 'qhse_investigacion_enviada_a_revision',
    descripcion:
      'Una investigación llegó a revisión: el Gerente HSE debe aprobar el informe o devolverlo.',
    asunto: 'Investigación por revisar: {{codigo}}',
    intro:
      'Como <strong>{{cargo}}</strong>, la investigación <strong>{{codigo}}</strong> ({{resultadoNombre}}) está lista para su revisión: apruebe el informe y ciérrela, o devuélvala con sus observaciones.',
    introTexto:
      'Como {{cargo}}, la investigación {{codigo}} ({{resultadoNombre}}) está lista para su revisión: apruebe el informe y ciérrela, o devuélvala con sus observaciones.',
    filas: [
      ['Investigación', 'codigo'],
      ['Resultado', 'resultadoNombre'],
      ['Conclusión', 'conclusion'],
    ],
    titulo: 'Investigación por revisar: {{codigo}}',
    detalle: '{{resultadoNombre}}',
    enlace: '/dashboard/qhse/investigaciones',
    tono: 'info',
    roles: ['gerente_hse'],
  },
  {
    evento: 'qhse.investigacion.devuelta',
    codigo: 'qhse_investigacion_devuelta',
    descripcion: 'El Gerente HSE devolvió una investigación con observaciones.',
    asunto: 'Investigación devuelta: {{codigo}}',
    intro:
      'Como <strong>{{cargo}}</strong>, el Gerente HSE devolvió la investigación <strong>{{codigo}}</strong> ({{resultadoNombre}}) con esta observación: {{observacion}}',
    introTexto:
      'Como {{cargo}}, el Gerente HSE devolvió la investigación {{codigo}} ({{resultadoNombre}}) con esta observación: {{observacion}}',
    filas: [
      ['Investigación', 'codigo'],
      ['Resultado', 'resultadoNombre'],
    ],
    titulo: 'Investigación devuelta: {{codigo}}',
    detalle: '{{observacion}}',
    enlace: '/dashboard/qhse/investigaciones',
    tono: 'warning',
    roles: ['tecnico_hse'],
  },
];

export const PLANTILLAS_QHSE_VENCIMIENTOS: PlantillaDef[] = DEFINICIONES.flatMap(aPlantillas);

/** Eventos de este archivo (para suscribir el consumidor de avisos). */
export const EVENTOS_QHSE_VENCIMIENTOS: string[] = [...new Set(DEFINICIONES.map((d) => d.evento))];
