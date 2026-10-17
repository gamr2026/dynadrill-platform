-- Marca las categorías de químicos (las que Ventas elige como "Material químico" y las que exigen hoja MSDS al despachar), para no
-- depender del texto del nombre de la categoría.
ALTER TABLE "categoria_articulo" ADD COLUMN "es_quimica" BOOLEAN NOT NULL DEFAULT false;
COMMENT ON COLUMN "categoria_articulo"."es_quimica" IS 'La categoría agrupa químicos (Pumping los asigna al ticket; el despacho admite hoja MSDS).';
