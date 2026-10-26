-- CM-1 (PARIDAD-MODELO-DEMO.md): el documento adjunto al pedido lleva la descripción que pide la demo. Los ya adjuntos toman el nombre
-- original del archivo.
ALTER TABLE "pedido_documento" ADD COLUMN "descripcion" TEXT;
UPDATE "pedido_documento" d SET "descripcion" = a."nombre_original" FROM archivos.archivo a WHERE a."id" = d."archivo_id";
UPDATE "pedido_documento" SET "descripcion" = 'Documento' WHERE "descripcion" IS NULL OR length(btrim("descripcion")) = 0;
ALTER TABLE "pedido_documento"
  ALTER COLUMN "descripcion" SET NOT NULL,
  ADD CONSTRAINT "pedido_documento_descripcion_check" CHECK (length(btrim("descripcion")) > 0);
COMMENT ON COLUMN "pedido_documento"."descripcion" IS 'Qué es el documento, escrito por quien lo adjunta (si no la escribe, el nombre del archivo).';
