-- Auditoría de la base (26/10/2026): los nombres, códigos, títulos, descripciones y motivos obligatorios no pueden estar vacíos ni ser solo espacios.
ALTER TABLE "auditoria"."clave_dato"
  ADD CONSTRAINT "clave_dato_descripcion_no_vacio_check" CHECK (length(btrim("descripcion")) > 0);
