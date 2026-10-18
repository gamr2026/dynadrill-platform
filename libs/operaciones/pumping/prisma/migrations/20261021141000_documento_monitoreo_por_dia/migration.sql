-- El monitoreo es de un día de operación: lleva su fecha (y solo él). Varios archivos por día son historia; el vigente es el último.
ALTER TABLE "ticket_documento" ADD COLUMN "fecha" DATE;
ALTER TABLE "ticket_documento" ADD CONSTRAINT "ticket_documento_fecha_check" CHECK (("tipo" = 'monitoreo') = ("fecha" IS NOT NULL));
CREATE INDEX "ticket_documento_dia_idx" ON "ticket_documento"("ticket_id", "tipo", "fecha");
COMMENT ON COLUMN "ticket_documento"."fecha" IS 'Día de operación del monitoreo (solo en los documentos de tipo monitoreo).';
