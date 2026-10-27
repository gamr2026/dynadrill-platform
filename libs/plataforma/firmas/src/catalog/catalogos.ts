/**
 * Catálogos de Firmas. Un documento o un papel que no esté aquí se rechaza: define qué cuenta como firma. Un módulo que empiece a
 * firmar un documento nuevo lo agrega aquí y corre `npm run db:seed:firmas`.
 */
export interface EntradaCatalogo {
  codigo: string;
  descripcion: string;
}

/** Documentos que hoy se firman «de una línea» (decisión D6) y los que el módulo dueño ya adopta. */
export const DOCUMENTOS_FIRMABLES: readonly EntradaCatalogo[] = [
  { codigo: 'qhse_ptw', descripcion: 'Permiso de trabajo (PTW)' },
  { codigo: 'qhse_iperc', descripcion: 'Matriz IPERC' },
  { codigo: 'qhse_stop', descripcion: 'Tarjeta STOP' },
  { codigo: 'qhse_swa', descripcion: 'Stop Work Authority (SWA)' },
  { codigo: 'qhse_desecho', descripcion: 'Manifiesto de desechos' },
  { codigo: 'qhse_entrega_epi', descripcion: 'Entrega de equipo de protección personal' },
  { codigo: 'fcr_inspeccion', descripcion: 'Inspección y reparación de herramientas de FCR' },
  { codigo: 'pumping_reporte_diario', descripcion: 'Reporte Diario de Actividades de Pumping (DYN-SGI-RE-047)' },
  { codigo: 'flota_gerenciamiento_viaje', descripcion: 'Gerenciamiento de viaje (DYN-SGI-RE-046)' },
];

/** Papeles de quien firma: los que hoy usan PTW, la entrega de EPI y la inspección de FCR. */
export const ROLES_FIRMANTE: readonly EntradaCatalogo[] = [
  { codigo: 'trabajador', descripcion: 'Trabajador que recibe o ejecuta' },
  { codigo: 'talento_humano', descripcion: 'Talento Humano' },
  { codigo: 'ptw_en_sitio', descripcion: 'PTW en sitio' },
  { codigo: 'acta_recibimiento', descripcion: 'Acta de recibimiento' },
  { codigo: 'barricadas', descripcion: 'Barricadas' },
  { codigo: 'aprobacion', descripcion: 'Aprobación' },
  { codigo: 'reparado_por', descripcion: 'Reparado por' },
  { codigo: 'revisado_por', descripcion: 'Revisado por' },
  { codigo: 'liberado_qhse', descripcion: 'Liberado por QHSE' },
  { codigo: 'despachado_por', descripcion: 'Despachado por (manifiesto de desechos)' },
  { codigo: 'transportado_por', descripcion: 'Transportado por (manifiesto de desechos)' },
  { codigo: 'recibido_por', descripcion: 'Recibido por (manifiesto de desechos)' },
  { codigo: 'supervisor', descripcion: 'Supervisor de Dynadrill' },
  { codigo: 'representante_cliente', descripcion: 'Representante del cliente (Company Man)' },
  { codigo: 'conductor', descripcion: 'Conductor que solicita el viaje' },
  { codigo: 'aprobador', descripcion: 'Quien autoriza o rechaza el viaje' },
];
