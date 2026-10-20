-- Los documentos de un ticket de Pumping (mezcla y monitoreo) los ve quien tiene `pumping.documentos.ver` (el equipo del ticket y Facturación,
-- que arma la prefactura con ellos), no solo quien puede operar tickets.
UPDATE "archivos"."modulo_archivo"
SET "permiso_ver" = 'pumping.documentos.ver'
WHERE "codigo" IN ('ticket_mezcla_documento', 'ticket_monitoreo_documento');
