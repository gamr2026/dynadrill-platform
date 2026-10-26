-- Auditoría de la base (26/10/2026): cuatro columnas uuid que apuntan a tablas del mismo contenedor no tenían FK. Se comprobó que no hay filas huérfanas.
ALTER TABLE "guia_remision"
  ADD CONSTRAINT "guia_remision_emision_id_fkey" FOREIGN KEY ("emision_id") REFERENCES "secuencia_emision" ("id");
ALTER TABLE "orden_trabajo"
  ADD CONSTRAINT "orden_trabajo_emision_id_fkey" FOREIGN KEY ("emision_id") REFERENCES "secuencia_emision" ("id"),
  ADD CONSTRAINT "orden_trabajo_prefactura_id_fkey" FOREIGN KEY ("prefactura_id") REFERENCES "prefactura" ("id");
ALTER TABLE "pedido"
  ADD CONSTRAINT "pedido_ticket_emision_id_fkey" FOREIGN KEY ("ticket_emision_id") REFERENCES "secuencia_emision" ("id");
CREATE INDEX "guia_remision_emision_id_idx" ON "guia_remision" ("emision_id");
CREATE INDEX "orden_trabajo_emision_id_idx" ON "orden_trabajo" ("emision_id");
CREATE INDEX "orden_trabajo_prefactura_id_idx" ON "orden_trabajo" ("prefactura_id");
CREATE INDEX "pedido_ticket_emision_id_idx" ON "pedido" ("ticket_emision_id");

-- Las que siguen sin FK lo son a propósito: apuntan a otro contenedor o a varias tablas (decisión D1).
COMMENT ON COLUMN "documento_respaldo_firmado"."documento_ticket_id" IS 'Documento del ticket de Pumping (otro contenedor, D1): uuid sin FK; se valida contra Pumping al firmar.';
COMMENT ON COLUMN "pedido_ticket_operativo"."ticket_id" IS 'Ticket del módulo operativo (Pumping o FCR, otro contenedor, D1): uuid sin FK.';
COMMENT ON COLUMN "proceso_historial"."entidad_id" IS 'Id de la entidad que cambió de estado; según `proceso` es un pedido, una prefactura u otra (varias tablas: no admite FK).';
COMMENT ON COLUMN "proceso_historial"."evento_id" IS 'Id del evento que originó el cambio, si lo hubo (el evento está en el outbox o inbox del contenedor): sin FK.';
COMMENT ON COLUMN "secuencia_emision"."documento_ref_id" IS 'Id del documento que recibió el número (pedido, prefactura, guía...: varias tablas, no admite FK); nulo si aún no se asignó.';
