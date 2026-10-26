-- Auditoría de la base (26/10/2026): los nombres, códigos, títulos, descripciones y motivos obligatorios no pueden estar vacíos ni ser solo espacios.
ALTER TABLE "pumping"."gas_limite"
  ADD CONSTRAINT "gas_limite_nombre_no_vacio_check" CHECK (length(btrim("nombre")) > 0);
ALTER TABLE "pumping"."paso"
  ADD CONSTRAINT "paso_nombre_no_vacio_check" CHECK (length(btrim("nombre")) > 0);
ALTER TABLE "pumping"."requisito"
  ADD CONSTRAINT "requisito_nombre_no_vacio_check" CHECK (length(btrim("nombre")) > 0);
ALTER TABLE "pumping"."solicitud_cambio_item"
  ADD CONSTRAINT "solicitud_cambio_item_codigo_no_vacio_check" CHECK (length(btrim("codigo")) > 0),
  ADD CONSTRAINT "solicitud_cambio_item_descripcion_no_vacio_check" CHECK (length(btrim("descripcion")) > 0);
ALTER TABLE "pumping"."terminos_version"
  ADD CONSTRAINT "terminos_version_titulo_no_vacio_check" CHECK (length(btrim("titulo")) > 0);
