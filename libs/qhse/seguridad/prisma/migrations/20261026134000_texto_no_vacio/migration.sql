-- Auditoría de la base (26/10/2026): los nombres, códigos, títulos, descripciones y motivos obligatorios no pueden estar vacíos ni ser solo espacios.
ALTER TABLE "qhse"."aspecto_etapa_ciclo_vida"
  ADD CONSTRAINT "aspecto_etapa_ciclo_vida_codigo_no_vacio_check" CHECK (length(btrim("codigo")) > 0),
  ADD CONSTRAINT "aspecto_etapa_ciclo_vida_nombre_no_vacio_check" CHECK (length(btrim("nombre")) > 0);
ALTER TABLE "qhse"."aspecto_factor_ambiental"
  ADD CONSTRAINT "aspecto_factor_ambiental_codigo_no_vacio_check" CHECK (length(btrim("codigo")) > 0),
  ADD CONSTRAINT "aspecto_factor_ambiental_nombre_no_vacio_check" CHECK (length(btrim("nombre")) > 0);
ALTER TABLE "qhse"."derrame_banda_volumen"
  ADD CONSTRAINT "derrame_banda_volumen_codigo_no_vacio_check" CHECK (length(btrim("codigo")) > 0),
  ADD CONSTRAINT "derrame_banda_volumen_nombre_no_vacio_check" CHECK (length(btrim("nombre")) > 0);
ALTER TABLE "qhse"."derrame_checklist_item"
  ADD CONSTRAINT "derrame_checklist_item_codigo_no_vacio_check" CHECK (length(btrim("codigo")) > 0),
  ADD CONSTRAINT "derrame_checklist_item_nombre_no_vacio_check" CHECK (length(btrim("nombre")) > 0);
ALTER TABLE "qhse"."derrame_ubicacion"
  ADD CONSTRAINT "derrame_ubicacion_codigo_no_vacio_check" CHECK (length(btrim("codigo")) > 0),
  ADD CONSTRAINT "derrame_ubicacion_nombre_no_vacio_check" CHECK (length(btrim("nombre")) > 0);
ALTER TABLE "qhse"."desecho_caracteristica"
  ADD CONSTRAINT "desecho_caracteristica_codigo_no_vacio_check" CHECK (length(btrim("codigo")) > 0),
  ADD CONSTRAINT "desecho_caracteristica_nombre_no_vacio_check" CHECK (length(btrim("nombre")) > 0);
ALTER TABLE "qhse"."desecho_contenedor"
  ADD CONSTRAINT "desecho_contenedor_codigo_no_vacio_check" CHECK (length(btrim("codigo")) > 0),
  ADD CONSTRAINT "desecho_contenedor_nombre_no_vacio_check" CHECK (length(btrim("nombre")) > 0);
ALTER TABLE "qhse"."desecho_estado"
  ADD CONSTRAINT "desecho_estado_codigo_no_vacio_check" CHECK (length(btrim("codigo")) > 0),
  ADD CONSTRAINT "desecho_estado_nombre_no_vacio_check" CHECK (length(btrim("nombre")) > 0);
ALTER TABLE "qhse"."emergencia_tipo"
  ADD CONSTRAINT "emergencia_tipo_codigo_no_vacio_check" CHECK (length(btrim("codigo")) > 0),
  ADD CONSTRAINT "emergencia_tipo_nombre_no_vacio_check" CHECK (length(btrim("nombre")) > 0);
ALTER TABLE "qhse"."frecuencia_seguimiento"
  ADD CONSTRAINT "frecuencia_seguimiento_codigo_no_vacio_check" CHECK (length(btrim("codigo")) > 0),
  ADD CONSTRAINT "frecuencia_seguimiento_nombre_no_vacio_check" CHECK (length(btrim("nombre")) > 0);
ALTER TABLE "qhse"."inspeccion_criterio"
  ADD CONSTRAINT "inspeccion_criterio_nombre_no_vacio_check" CHECK (length(btrim("nombre")) > 0);
ALTER TABLE "qhse"."inspeccion_tipo"
  ADD CONSTRAINT "inspeccion_tipo_codigo_no_vacio_check" CHECK (length(btrim("codigo")) > 0),
  ADD CONSTRAINT "inspeccion_tipo_nombre_no_vacio_check" CHECK (length(btrim("nombre")) > 0);
ALTER TABLE "qhse"."investigacion_resultado"
  ADD CONSTRAINT "investigacion_resultado_codigo_no_vacio_check" CHECK (length(btrim("codigo")) > 0),
  ADD CONSTRAINT "investigacion_resultado_nombre_no_vacio_check" CHECK (length(btrim("nombre")) > 0);
ALTER TABLE "qhse"."iperc_cargo"
  ADD CONSTRAINT "iperc_cargo_codigo_no_vacio_check" CHECK (length(btrim("codigo")) > 0),
  ADD CONSTRAINT "iperc_cargo_nombre_no_vacio_check" CHECK (length(btrim("nombre")) > 0);
ALTER TABLE "qhse"."iperc_clasificacion_peligro"
  ADD CONSTRAINT "iperc_clasificacion_peligro_codigo_no_vacio_check" CHECK (length(btrim("codigo")) > 0),
  ADD CONSTRAINT "iperc_clasificacion_peligro_nombre_no_vacio_check" CHECK (length(btrim("nombre")) > 0);
ALTER TABLE "qhse"."iperc_generado_en"
  ADD CONSTRAINT "iperc_generado_en_codigo_no_vacio_check" CHECK (length(btrim("codigo")) > 0),
  ADD CONSTRAINT "iperc_generado_en_nombre_no_vacio_check" CHECK (length(btrim("nombre")) > 0);
ALTER TABLE "qhse"."iperc_proceso"
  ADD CONSTRAINT "iperc_proceso_codigo_no_vacio_check" CHECK (length(btrim("codigo")) > 0),
  ADD CONSTRAINT "iperc_proceso_nombre_no_vacio_check" CHECK (length(btrim("nombre")) > 0);
ALTER TABLE "qhse"."iperc_zona"
  ADD CONSTRAINT "iperc_zona_codigo_no_vacio_check" CHECK (length(btrim("codigo")) > 0),
  ADD CONSTRAINT "iperc_zona_nombre_no_vacio_check" CHECK (length(btrim("nombre")) > 0);
ALTER TABLE "qhse"."ishikawa_categoria"
  ADD CONSTRAINT "ishikawa_categoria_codigo_no_vacio_check" CHECK (length(btrim("codigo")) > 0),
  ADD CONSTRAINT "ishikawa_categoria_nombre_no_vacio_check" CHECK (length(btrim("nombre")) > 0);
ALTER TABLE "qhse"."requisito_legal_tipo"
  ADD CONSTRAINT "requisito_legal_tipo_codigo_no_vacio_check" CHECK (length(btrim("codigo")) > 0),
  ADD CONSTRAINT "requisito_legal_tipo_nombre_no_vacio_check" CHECK (length(btrim("nombre")) > 0);
ALTER TABLE "qhse"."stop_item"
  ADD CONSTRAINT "stop_item_nombre_no_vacio_check" CHECK (length(btrim("nombre")) > 0);
ALTER TABLE "qhse"."stop_subcategoria"
  ADD CONSTRAINT "stop_subcategoria_codigo_no_vacio_check" CHECK (length(btrim("codigo")) > 0),
  ADD CONSTRAINT "stop_subcategoria_nombre_no_vacio_check" CHECK (length(btrim("nombre")) > 0);
ALTER TABLE "qhse"."swa_criterio_reinicio"
  ADD CONSTRAINT "swa_criterio_reinicio_codigo_no_vacio_check" CHECK (length(btrim("codigo")) > 0),
  ADD CONSTRAINT "swa_criterio_reinicio_nombre_no_vacio_check" CHECK (length(btrim("nombre")) > 0);
ALTER TABLE "qhse"."swa_tipo_peligro"
  ADD CONSTRAINT "swa_tipo_peligro_codigo_no_vacio_check" CHECK (length(btrim("codigo")) > 0),
  ADD CONSTRAINT "swa_tipo_peligro_nombre_no_vacio_check" CHECK (length(btrim("nombre")) > 0);
