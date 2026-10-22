-- La hoja de Facturación del Reporte de Herramientas de FCR muestra una celda por ítem y día: cada uso lleva su cantidad.
-- Los usos ya guardados eran marcas (valían 1), por eso el valor por defecto. El total de la herramienta sigue en
-- `documento_operativo_herramienta.cantidad`, que es lo que se factura; la suma de los usos con cantidad debe coincidir con él (la valida el servicio).
ALTER TABLE "documento_operativo_uso"
  ADD COLUMN "cantidad" NUMERIC(14,3) NOT NULL DEFAULT 1,
  ADD CONSTRAINT "documento_operativo_uso_cantidad_positiva" CHECK ("cantidad" > 0);
COMMENT ON COLUMN "documento_operativo_uso"."cantidad" IS 'Cantidad aplicada ese día (1 en las filas por día, cuyo uso es una marca; el valor del día en las demás).';
