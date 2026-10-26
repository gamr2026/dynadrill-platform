-- Auditoría de la base (26/10/2026): los nombres, códigos, títulos, descripciones y motivos obligatorios no pueden estar vacíos ni ser solo espacios.
ALTER TABLE "archivos"."modulo_archivo"
  ADD CONSTRAINT "modulo_archivo_codigo_no_vacio_check" CHECK (length(btrim("codigo")) > 0),
  ADD CONSTRAINT "modulo_archivo_nombre_no_vacio_check" CHECK (length(btrim("nombre")) > 0);
