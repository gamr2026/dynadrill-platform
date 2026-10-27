-- Los códigos de relleno del registro de inspección de herramientas (el Excel del cliente) — «---------», vacío, «Not Required», «N/A», «No#--» —
-- significan «esta parte no tiene código»: se guardan como NULL. Un mismo código SÍ puede repetirse dentro de una herramienta (varias posiciones
-- que usan la misma pieza, p. ej. un o-ring), por eso no se exige unicidad; la posición de la parte es (articulo_id, orden).
ALTER TABLE "articulo_parte" ALTER COLUMN "codigo" DROP NOT NULL;
UPDATE "articulo_parte" SET "codigo" = NULL
 WHERE btrim("codigo") = ''
    OR "codigo" ~ '^-+$'
    OR lower(btrim("codigo")) IN ('not required', 'n/a', 'na')
    OR "codigo" ~ '^No#-+$';
UPDATE "articulo_parte" SET "codigo" = btrim("codigo") WHERE "codigo" <> btrim("codigo");
ALTER TABLE "articulo_parte"
  ADD CONSTRAINT "articulo_parte_codigo_no_vacio_check" CHECK ("codigo" IS NULL OR length(btrim("codigo")) > 0);
COMMENT ON COLUMN "articulo_parte"."codigo" IS 'Código de la parte en el catálogo del fabricante; NULL si el registro de origen no lo trae. Puede repetirse dentro de la herramienta.';
