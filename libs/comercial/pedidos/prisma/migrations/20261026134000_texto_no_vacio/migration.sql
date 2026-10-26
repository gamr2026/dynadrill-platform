-- Auditoría de la base (26/10/2026): los nombres, códigos, títulos, descripciones y motivos obligatorios no pueden estar vacíos ni ser solo espacios.
ALTER TABLE "comercial"."ciudad_ot"
  ADD CONSTRAINT "ciudad_ot_codigo_no_vacio_check" CHECK (length(btrim("codigo")) > 0),
  ADD CONSTRAINT "ciudad_ot_nombre_no_vacio_check" CHECK (length(btrim("nombre")) > 0);
ALTER TABLE "comercial"."documento"
  ADD CONSTRAINT "documento_nombre_no_vacio_check" CHECK (length(btrim("nombre")) > 0);
ALTER TABLE "comercial"."documento_operativo_herramienta"
  ADD CONSTRAINT "documento_operativo_herramienta_nombre_no_vacio_check" CHECK (length(btrim("nombre")) > 0);
ALTER TABLE "comercial"."firmante_contratista"
  ADD CONSTRAINT "firmante_contratista_nombre_no_vacio_check" CHECK (length(btrim("nombre")) > 0);
ALTER TABLE "comercial"."guia_remision"
  ADD CONSTRAINT "guia_remision_codigo_no_vacio_check" CHECK (length(btrim("codigo")) > 0);
ALTER TABLE "comercial"."guia_remision_item"
  ADD CONSTRAINT "guia_remision_item_descripcion_no_vacio_check" CHECK (length(btrim("descripcion")) > 0);
ALTER TABLE "comercial"."lista_precios_item"
  ADD CONSTRAINT "lista_precios_item_codigo_no_vacio_check" CHECK (length(btrim("codigo")) > 0),
  ADD CONSTRAINT "lista_precios_item_descripcion_no_vacio_check" CHECK (length(btrim("descripcion")) > 0);
ALTER TABLE "comercial"."lugar_despacho"
  ADD CONSTRAINT "lugar_despacho_nombre_no_vacio_check" CHECK (length(btrim("nombre")) > 0);
ALTER TABLE "comercial"."orden_trabajo"
  ADD CONSTRAINT "orden_trabajo_codigo_no_vacio_check" CHECK (length(btrim("codigo")) > 0);
ALTER TABLE "comercial"."orden_trabajo_item"
  ADD CONSTRAINT "orden_trabajo_item_descripcion_no_vacio_check" CHECK (length(btrim("descripcion")) > 0);
ALTER TABLE "comercial"."pedido_item"
  ADD CONSTRAINT "pedido_item_codigo_no_vacio_check" CHECK (length(btrim("codigo")) > 0),
  ADD CONSTRAINT "pedido_item_descripcion_no_vacio_check" CHECK (length(btrim("descripcion")) > 0);
ALTER TABLE "comercial"."prefactura_firma"
  ADD CONSTRAINT "prefactura_firma_nombre_no_vacio_check" CHECK (length(btrim("nombre")) > 0);
ALTER TABLE "comercial"."prefactura_item"
  ADD CONSTRAINT "prefactura_item_codigo_no_vacio_check" CHECK (length(btrim("codigo")) > 0),
  ADD CONSTRAINT "prefactura_item_descripcion_no_vacio_check" CHECK (length(btrim("descripcion")) > 0);
ALTER TABLE "comercial"."proceso_estado"
  ADD CONSTRAINT "proceso_estado_nombre_no_vacio_check" CHECK (length(btrim("nombre")) > 0);
ALTER TABLE "comercial"."servicio_linea"
  ADD CONSTRAINT "servicio_linea_codigo_no_vacio_check" CHECK (length(btrim("codigo")) > 0),
  ADD CONSTRAINT "servicio_linea_nombre_no_vacio_check" CHECK (length(btrim("nombre")) > 0);
ALTER TABLE "comercial"."servicio_subtipo"
  ADD CONSTRAINT "servicio_subtipo_nombre_no_vacio_check" CHECK (length(btrim("nombre")) > 0);
ALTER TABLE "comercial"."servicio_tipo"
  ADD CONSTRAINT "servicio_tipo_codigo_no_vacio_check" CHECK (length(btrim("codigo")) > 0),
  ADD CONSTRAINT "servicio_tipo_nombre_no_vacio_check" CHECK (length(btrim("nombre")) > 0);
ALTER TABLE "comercial"."tipo_ot"
  ADD CONSTRAINT "tipo_ot_codigo_no_vacio_check" CHECK (length(btrim("codigo")) > 0),
  ADD CONSTRAINT "tipo_ot_nombre_no_vacio_check" CHECK (length(btrim("nombre")) > 0);
