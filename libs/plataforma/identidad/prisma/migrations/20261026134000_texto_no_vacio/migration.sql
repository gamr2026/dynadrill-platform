-- Auditoría de la base (26/10/2026): los nombres, códigos, títulos, descripciones y motivos obligatorios no pueden estar vacíos ni ser solo espacios.
ALTER TABLE "identidad"."permiso"
  ADD CONSTRAINT "permiso_codigo_no_vacio_check" CHECK (length(btrim("codigo")) > 0),
  ADD CONSTRAINT "permiso_descripcion_no_vacio_check" CHECK (length(btrim("descripcion")) > 0);
ALTER TABLE "identidad"."rol"
  ADD CONSTRAINT "rol_codigo_no_vacio_check" CHECK (length(btrim("codigo")) > 0),
  ADD CONSTRAINT "rol_nombre_no_vacio_check" CHECK (length(btrim("nombre")) > 0);
ALTER TABLE "identidad"."usuario"
  ADD CONSTRAINT "usuario_nombre_no_vacio_check" CHECK (length(btrim("nombre")) > 0);
