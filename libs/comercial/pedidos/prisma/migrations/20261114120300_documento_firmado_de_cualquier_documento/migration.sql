-- El documento firmado ya no es solo el monitoreo o la mezcla de Pumping: `documento_ticket_id` pasa a ser el id del documento de origen
-- (el refId que da el índice del expediente), y la versión vigente se busca por tipo + id de origen.
COMMENT ON COLUMN "documento_respaldo_firmado"."documento_ticket_id" IS 'Id del documento de origen al que corresponde la versión firmada: el refId del índice del expediente para ese tipo (documento operativo, documento de Pumping, QHSE, FCR, inspección, viaje, orden de mantenimiento, prefactura, guía, OT o adjunto). Sin FK: puede estar en otro contenedor.';
COMMENT ON COLUMN "documento_respaldo_firmado"."fecha" IS 'Día del documento cuando es de un día (monitoreo, Reporte Job, reporte de unidad); obligatorio solo en el monitoreo.';
-- la fecha ya no es exclusiva del monitoreo; solo es obligatoria en él
ALTER TABLE "documento_respaldo_firmado" DROP CONSTRAINT "documento_respaldo_firmado_monitoreo_fecha_check";
ALTER TABLE "documento_respaldo_firmado"
  ADD CONSTRAINT "documento_respaldo_firmado_monitoreo_fecha_check" CHECK ("tipo" <> 'monitoreo' OR "fecha" IS NOT NULL);
DROP INDEX "documento_respaldo_firmado_pedido_id_documento_ticket_id_idx";
CREATE INDEX "documento_respaldo_firmado_pedido_id_tipo_documento_ticket_id_idx"
  ON "documento_respaldo_firmado"("pedido_id", "tipo", "documento_ticket_id");
