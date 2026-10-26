-- Auditoría de la base (26/10/2026): los nombres, códigos, títulos, descripciones y motivos obligatorios no pueden estar vacíos ni ser solo espacios.
ALTER TABLE "inventario"."articulo"
  ADD CONSTRAINT "articulo_codigo_no_vacio_check" CHECK (length(btrim("codigo")) > 0),
  ADD CONSTRAINT "articulo_nombre_no_vacio_check" CHECK (length(btrim("nombre")) > 0);
ALTER TABLE "inventario"."articulo_codigo"
  ADD CONSTRAINT "articulo_codigo_codigo_no_vacio_check" CHECK (length(btrim("codigo")) > 0);
ALTER TABLE "inventario"."articulo_parte"
  ADD CONSTRAINT "articulo_parte_descripcion_no_vacio_check" CHECK (length(btrim("descripcion")) > 0);
ALTER TABLE "inventario"."categoria_articulo"
  ADD CONSTRAINT "categoria_articulo_nombre_no_vacio_check" CHECK (length(btrim("nombre")) > 0);
ALTER TABLE "inventario"."motivo_movimiento"
  ADD CONSTRAINT "motivo_movimiento_nombre_no_vacio_check" CHECK (length(btrim("nombre")) > 0);
ALTER TABLE "inventario"."subcategoria_articulo"
  ADD CONSTRAINT "subcategoria_articulo_nombre_no_vacio_check" CHECK (length(btrim("nombre")) > 0);
