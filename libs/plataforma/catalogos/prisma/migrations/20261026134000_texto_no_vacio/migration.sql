-- Auditoría de la base (26/10/2026): los nombres, códigos, títulos, descripciones y motivos obligatorios no pueden estar vacíos ni ser solo espacios.
ALTER TABLE "catalogos"."bloque"
  ADD CONSTRAINT "bloque_nombre_no_vacio_check" CHECK (length(btrim("nombre")) > 0);
ALTER TABLE "catalogos"."bodega"
  ADD CONSTRAINT "bodega_nombre_no_vacio_check" CHECK (length(btrim("nombre")) > 0);
ALTER TABLE "catalogos"."campo"
  ADD CONSTRAINT "campo_nombre_no_vacio_check" CHECK (length(btrim("nombre")) > 0);
ALTER TABLE "catalogos"."chofer"
  ADD CONSTRAINT "chofer_nombre_no_vacio_check" CHECK (length(btrim("nombre")) > 0);
ALTER TABLE "catalogos"."condicion_pago"
  ADD CONSTRAINT "condicion_pago_nombre_no_vacio_check" CHECK (length(btrim("nombre")) > 0);
ALTER TABLE "catalogos"."persona_contacto"
  ADD CONSTRAINT "persona_contacto_nombre_no_vacio_check" CHECK (length(btrim("nombre")) > 0);
ALTER TABLE "catalogos"."pozo"
  ADD CONSTRAINT "pozo_codigo_no_vacio_check" CHECK (length(btrim("codigo")) > 0);
ALTER TABLE "catalogos"."taladro"
  ADD CONSTRAINT "taladro_nombre_no_vacio_check" CHECK (length(btrim("nombre")) > 0);
ALTER TABLE "catalogos"."tipo_vehiculo"
  ADD CONSTRAINT "tipo_vehiculo_nombre_no_vacio_check" CHECK (length(btrim("nombre")) > 0);
ALTER TABLE "catalogos"."zona"
  ADD CONSTRAINT "zona_nombre_no_vacio_check" CHECK (length(btrim("nombre")) > 0);
