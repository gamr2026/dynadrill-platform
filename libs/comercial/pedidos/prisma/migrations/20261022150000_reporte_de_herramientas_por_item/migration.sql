-- El Reporte de Herramientas de FCR llega por ítem de la lista de precios con su cantidad real (marcas por día o cantidad escrita). De esa cantidad salen la
-- prefactura, la guía de remisión y la orden de trabajo; lo cotizado en el pedido ya no se factura cuando existe el reporte.
ALTER TABLE "documento_operativo_herramienta"
  ADD COLUMN "unidad" TEXT,
  ADD COLUMN "cantidad" NUMERIC(14,3),
  ADD CONSTRAINT "documento_operativo_herramienta_cantidad_check" CHECK ("cantidad" IS NULL OR "cantidad" >= 0);
COMMENT ON COLUMN "documento_operativo_herramienta"."cantidad" IS 'Cantidad real del ítem según el reporte (nula en reportes anteriores, que se cobraban por los días de uso).';
