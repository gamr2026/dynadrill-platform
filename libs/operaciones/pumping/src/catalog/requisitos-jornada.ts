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
} as const;
