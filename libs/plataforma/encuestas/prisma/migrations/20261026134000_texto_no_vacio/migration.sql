-- Auditoría de la base (26/10/2026): los nombres, códigos, títulos, descripciones y motivos obligatorios no pueden estar vacíos ni ser solo espacios.
ALTER TABLE "encuestas"."escala"
  ADD CONSTRAINT "escala_codigo_no_vacio_check" CHECK (length(btrim("codigo")) > 0),
  ADD CONSTRAINT "escala_nombre_no_vacio_check" CHECK (length(btrim("nombre")) > 0);
ALTER TABLE "encuestas"."modulo_encuesta"
  ADD CONSTRAINT "modulo_encuesta_nombre_no_vacio_check" CHECK (length(btrim("nombre")) > 0);
