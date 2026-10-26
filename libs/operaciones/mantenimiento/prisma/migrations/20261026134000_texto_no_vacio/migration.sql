-- Auditoría de la base (26/10/2026): los nombres, códigos, títulos, descripciones y motivos obligatorios no pueden estar vacíos ni ser solo espacios.
ALTER TABLE "mantenimiento"."estado_suborden"
  ADD CONSTRAINT "estado_suborden_codigo_no_vacio_check" CHECK (length(btrim("codigo")) > 0),
  ADD CONSTRAINT "estado_suborden_nombre_no_vacio_check" CHECK (length(btrim("nombre")) > 0);
ALTER TABLE "mantenimiento"."reporte_recibido"
  ADD CONSTRAINT "reporte_recibido_codigo_no_vacio_check" CHECK (length(btrim("codigo")) > 0);
ALTER TABLE "mantenimiento"."tipo_suborden"
  ADD CONSTRAINT "tipo_suborden_codigo_no_vacio_check" CHECK (length(btrim("codigo")) > 0),
  ADD CONSTRAINT "tipo_suborden_nombre_no_vacio_check" CHECK (length(btrim("nombre")) > 0);
