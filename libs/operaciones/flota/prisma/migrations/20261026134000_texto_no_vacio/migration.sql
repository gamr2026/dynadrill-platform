-- Auditoría de la base (26/10/2026): los nombres, códigos, títulos, descripciones y motivos obligatorios no pueden estar vacíos ni ser solo espacios.
ALTER TABLE "flota"."item_inspeccion_vehiculo"
  ADD CONSTRAINT "item_inspeccion_vehiculo_codigo_no_vacio_check" CHECK (length(btrim("codigo")) > 0);
ALTER TABLE "flota"."pregunta_riesgo_viaje"
  ADD CONSTRAINT "pregunta_riesgo_viaje_codigo_no_vacio_check" CHECK (length(btrim("codigo")) > 0);
ALTER TABLE "flota"."proveedor_mantenimiento"
  ADD CONSTRAINT "proveedor_mantenimiento_nombre_no_vacio_check" CHECK (length(btrim("nombre")) > 0);
ALTER TABLE "flota"."regla_preventiva"
  ADD CONSTRAINT "regla_preventiva_descripcion_no_vacio_check" CHECK (length(btrim("descripcion")) > 0);
ALTER TABLE "flota"."tipo_permiso_conductor"
  ADD CONSTRAINT "tipo_permiso_conductor_codigo_no_vacio_check" CHECK (length(btrim("codigo")) > 0),
  ADD CONSTRAINT "tipo_permiso_conductor_nombre_no_vacio_check" CHECK (length(btrim("nombre")) > 0);
ALTER TABLE "flota"."umbral_riesgo_viaje"
  ADD CONSTRAINT "umbral_riesgo_viaje_descripcion_no_vacio_check" CHECK (length(btrim("descripcion")) > 0);
ALTER TABLE "flota"."unidad"
  ADD CONSTRAINT "unidad_codigo_no_vacio_check" CHECK (length(btrim("codigo")) > 0),
  ADD CONSTRAINT "unidad_nombre_no_vacio_check" CHECK (length(btrim("nombre")) > 0);
