-- Auditoría de la base (26/10/2026): los nombres, códigos, títulos, descripciones y motivos obligatorios no pueden estar vacíos ni ser solo espacios.
ALTER TABLE "firmas"."documento_tipo"
  ADD CONSTRAINT "documento_tipo_descripcion_no_vacio_check" CHECK (length(btrim("descripcion")) > 0);
ALTER TABLE "firmas"."rol_firmante"
  ADD CONSTRAINT "rol_firmante_descripcion_no_vacio_check" CHECK (length(btrim("descripcion")) > 0);
