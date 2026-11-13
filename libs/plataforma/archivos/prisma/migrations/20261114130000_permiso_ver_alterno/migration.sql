-- Segundo permiso para VER un archivo de un módulo (con cualquiera de los dos basta). El expediente del pedido de Facturación
-- (`comercial.expediente.ver`) abre los documentos de QHSE y FCR y los del Reporte Diario sin darle a Facturación los permisos de
-- esos módulos. La siembra solo crea módulos que faltan, por eso el valor de los existentes se fija aquí.
ALTER TABLE "archivos"."modulo_archivo" ADD COLUMN "permiso_ver_alterno" TEXT;

COMMENT ON COLUMN "archivos"."modulo_archivo"."permiso_ver_alterno" IS 'Segundo permiso que también deja ver o descargar; nulo si el módulo solo admite permiso_ver.';

UPDATE "archivos"."modulo_archivo"
SET "permiso_ver_alterno" = 'comercial.expediente.ver'
WHERE "codigo" IN ('qhse_documento_pedido', 'qhse_acta_entrega', 'ticket_fcr_documento', 'ticket_reporte_diario_documento');
