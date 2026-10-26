-- Auditoría de la base (26/10/2026): los nombres, códigos, títulos, descripciones y motivos obligatorios no pueden estar vacíos ni ser solo espacios.
ALTER TABLE "integraciones"."proveedor"
  ADD CONSTRAINT "proveedor_nombre_no_vacio_check" CHECK (length(btrim("nombre")) > 0);
