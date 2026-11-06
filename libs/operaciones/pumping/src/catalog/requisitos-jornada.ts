/**
 * Códigos de los requisitos por día (ámbito `jornada`). El catálogo vive en la base de datos (migración 20261105131000); aquí solo están los
 * códigos que el código necesita nombrar. `apertura` bloquea abrir el día; `cierre`, cerrarlo.
 */
export const JREQ = {
  /** Apertura: el Supervisor marcó que el Company Man aceptó trabajar hoy. */
  companyMan: 'company_man_acepto_dia',
  /** Apertura (etapa 3): checklist de seguridad del día con las lecturas de gas y el LOTO de hoy. */
  checklist: 'checklist_seguridad_dia',
  /** Apertura (etapa 5, QHSE): PTW del día aprobado. */
  ptw: 'ptw_dia_aprobado',
  /** Apertura (etapa 5, QHSE): PT del día cargado. */
  pt: 'pt_dia_cargado',
  /** Apertura (etapa 5, QHSE): ART vigente que cubra el día. */
  art: 'art_vigente',
  /** Cierre: el Operador completó el job log del día. */
  jobLog: 'job_log_dia',
  /** Cierre: al menos una herramienta, ítem o cantidad marcada ese día en el Reporte de Herramientas. */
  herramientas: 'herramientas_dia',
  // Traslados de cada día (etapa 7c). Los «por unidad» tienen una fila por cada unidad de transporte del ticket.
  /** Apertura, por unidad (Flota): inspección de vehículos del día realizada. */
  inspeccionRealizada: 'inspeccion_vehiculo_dia',
  /** Apertura, por unidad (Flota): la inspección del día aprobada por el Supervisor. */
  inspeccionAprobada: 'inspeccion_aprobada_dia',
  /** Apertura, por unidad: el operador firmó el reporte de unidad de salida del día. */
  reporteSalida: 'reporte_unidad_salida_dia',
  /** Apertura, por unidad (Flota): gerenciamiento de viaje de salida del día aprobado. */
  gerenciamientoSalida: 'gerenciamiento_salida_dia',
  /** Apertura (QHSE): ninguna SWA activa en el servicio. */
  sinSwa: 'sin_swa_dia',
  /** Cierre, por unidad: el operador firmó el reporte de unidad de llegada del día. */
  reporteLlegada: 'reporte_unidad_llegada_dia',
  /** Cierre, por unidad (Flota): gerenciamiento de viaje de retorno del día aprobado. */
  gerenciamientoRetorno: 'gerenciamiento_retorno_dia',
} as const;

/** Requisito del traslado (antes de un paso del ticket) → su equivalente por día. Los eventos de Flota ya traen el día del servicio. */
export const REQUISITO_DEL_DIA: Record<string, string> = {
  inspeccion_vehiculo_realizada: JREQ.inspeccionRealizada,
  inspeccion_vehiculo_aprobada: JREQ.inspeccionAprobada,
  gerenciamiento_viaje_salida_aprobado: JREQ.gerenciamientoSalida,
  gerenciamiento_viaje_retorno_aprobado: JREQ.gerenciamientoRetorno,
};
