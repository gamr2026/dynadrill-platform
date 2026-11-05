-- Catálogo de los requisitos por día. `activo = false`: ya están definidos pero todavía no se exigen; se activan en la etapa que sabe
-- cumplirlos (checklist de seguridad por día: etapa 3; PTW, PT y ART del día desde QHSE: etapa 5).

ALTER TABLE "pumping"."requisito"
  ADD CONSTRAINT "requisito_momento_check" CHECK (("ambito" = 'jornada') = ("momento" IS NOT NULL));

INSERT INTO "pumping"."requisito" ("codigo", "nombre", "descripcion", "ambito", "modulo", "activo", "momento") VALUES
  ('company_man_acepto_dia', 'El Company Man aceptó trabajar hoy',
   'El Supervisor marcó que el Company Man aceptó trabajar ese día (casilla: el aviso se da de palabra en el área de trabajo).',
   'jornada', 'pumping', true, 'apertura'),
  ('checklist_seguridad_dia', 'Checklist de seguridad del día',
   'Charla de seguridad, recorrido, línea base, rutas de emergencia, SIMOPS, gases y LOTO del día. Las lecturas del día anterior no valen para hoy.',
   'jornada', 'pumping', false, 'apertura'),
  ('ptw_dia_aprobado', 'PTW del día aprobado',
   'QHSE aprobó el permiso de trabajo (PTW) de ese día. Sin él no se opera.',
   'jornada', 'qhse', false, 'apertura'),
  ('pt_dia_cargado', 'Permiso de trabajo (PT) del día cargado',
   'QHSE cargó el permiso de trabajo (PT) de ese día.',
   'jornada', 'qhse', false, 'apertura'),
  ('art_vigente', 'ART vigente para el día',
   'QHSE cargó un ART cuya vigencia cubre ese día (el ART se carga por rango de hasta 15 días).',
   'jornada', 'qhse', false, 'apertura'),
  ('job_log_dia', 'Reporte diario de actividades (job log) completado',
   'El Operador completó el job log del día.',
   'jornada', 'pumping', true, 'cierre'),
  ('herramientas_dia', 'Herramientas del día registradas',
   'El Operador marcó al menos una herramienta, ítem o cantidad usada ese día en el Reporte de Herramientas.',
   'jornada', 'pumping', true, 'cierre');
