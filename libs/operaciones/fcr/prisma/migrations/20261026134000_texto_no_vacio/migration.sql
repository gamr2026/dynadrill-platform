-- Auditoría de la base (26/10/2026): los nombres, códigos, títulos, descripciones y motivos obligatorios no pueden estar vacíos ni ser solo espacios.
ALTER TABLE "fcr"."paso"
  ADD CONSTRAINT "paso_nombre_no_vacio_check" CHECK (length(btrim("nombre")) > 0);
ALTER TABLE "fcr"."requisito"
  ADD CONSTRAINT "requisito_nombre_no_vacio_check" CHECK (length(btrim("nombre")) > 0);
ALTER TABLE "fcr"."solicitud_cambio_item"
  ADD CONSTRAINT "solicitud_cambio_item_codigo_no_vacio_check" CHECK (length(btrim("codigo")) > 0),
  ADD CONSTRAINT "solicitud_cambio_item_descripcion_no_vacio_check" CHECK (length(btrim("descripcion")) > 0);
ALTER TABLE "fcr"."ticket_linea"
  ADD CONSTRAINT "ticket_linea_codigo_no_vacio_check" CHECK (length(btrim("codigo")) > 0),
  ADD CONSTRAINT "ticket_linea_descripcion_no_vacio_check" CHECK (length(btrim("descripcion")) > 0);
ALTER TABLE "fcr"."tipo_completacion"
  ADD CONSTRAINT "tipo_completacion_codigo_no_vacio_check" CHECK (length(btrim("codigo")) > 0),
  ADD CONSTRAINT "tipo_completacion_nombre_no_vacio_check" CHECK (length(btrim("nombre")) > 0);
ALTER TABLE "fcr"."tipo_operador"
  ADD CONSTRAINT "tipo_operador_codigo_no_vacio_check" CHECK (length(btrim("codigo")) > 0),
  ADD CONSTRAINT "tipo_operador_nombre_no_vacio_check" CHECK (length(btrim("nombre")) > 0);
ALTER TABLE "fcr"."tipo_picker"
  ADD CONSTRAINT "tipo_picker_codigo_no_vacio_check" CHECK (length(btrim("codigo")) > 0),
  ADD CONSTRAINT "tipo_picker_nombre_no_vacio_check" CHECK (length(btrim("nombre")) > 0);
ALTER TABLE "fcr"."tipo_trabajo"
  ADD CONSTRAINT "tipo_trabajo_codigo_no_vacio_check" CHECK (length(btrim("codigo")) > 0),
  ADD CONSTRAINT "tipo_trabajo_nombre_no_vacio_check" CHECK (length(btrim("nombre")) > 0);
