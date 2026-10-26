-- Auditoría de la base (26/10/2026): los nombres, códigos, títulos, descripciones y motivos obligatorios no pueden estar vacíos ni ser solo espacios.
ALTER TABLE "avisos"."aviso"
  ADD CONSTRAINT "aviso_titulo_no_vacio_check" CHECK (length(btrim("titulo")) > 0);
ALTER TABLE "avisos"."plantilla"
  ADD CONSTRAINT "plantilla_codigo_no_vacio_check" CHECK (length(btrim("codigo")) > 0);
