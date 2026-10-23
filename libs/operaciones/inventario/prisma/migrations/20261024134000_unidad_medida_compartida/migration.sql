-- IN9: la unidad en que se lleva el stock de un artículo pasa a ser la unidad de medida compartida de la plataforma
-- (`catalogos.unidad_medida`, migración de catalogos 20261024133000, que debe haber corrido antes que esta). Las unidades de
-- `inventario.unidad_stock` se trasladan CONSERVANDO sus ids, así los artículos no cambian; si ya hubiera una unidad con el mismo nombre
-- en el catálogo compartido, los artículos pasan a esa. Después se cambia la FK y se elimina `inventario.unidad_stock`.

-- Inventario solo lee el catálogo compartido (FK real desde sus artículos)
GRANT USAGE ON SCHEMA catalogos TO app_operaciones;
GRANT SELECT ON catalogos.unidad_medida TO app_operaciones;

-- 1. Trasladar las unidades (mismo id, nombre, símbolo, estado y auditoría); las de nombre ya existente en el catálogo se omiten
INSERT INTO catalogos.unidad_medida (id, nombre, simbolo, habilitado, created_at, created_by, updated_at, updated_by)
SELECT u.id, u.nombre, u.simbolo, u.activo, u.created_at, u.created_by, u.updated_at, u.updated_by
  FROM inventario.unidad_stock u
 WHERE NOT EXISTS (SELECT 1 FROM catalogos.unidad_medida m WHERE lower(btrim(m.nombre)) = lower(btrim(u.nombre)));

-- 2. Los artículos de una unidad omitida (mismo nombre, otro id) pasan a la del catálogo compartido
UPDATE inventario.articulo a
   SET unidad_stock_id = m.id
  FROM inventario.unidad_stock u
  JOIN catalogos.unidad_medida m ON lower(btrim(m.nombre)) = lower(btrim(u.nombre))
 WHERE a.unidad_stock_id = u.id AND m.id <> u.id;

-- 3. Nada queda apuntando a una unidad que no existe en el catálogo compartido
DO $$
DECLARE
  huerfanos INTEGER;
BEGIN
  SELECT count(*) INTO huerfanos FROM inventario.articulo a
   WHERE NOT EXISTS (SELECT 1 FROM catalogos.unidad_medida m WHERE m.id = a.unidad_stock_id);
  IF huerfanos > 0 THEN
    RAISE EXCEPTION 'IN9: % artículo(s) quedaron con una unidad que no está en catalogos.unidad_medida', huerfanos;
  END IF;
END
$$;

-- 4. Cambiar la FK y quitar la tabla propia
ALTER TABLE inventario.articulo DROP CONSTRAINT "articulo_unidad_stock_id_fkey";
ALTER TABLE inventario.articulo
  ADD CONSTRAINT "articulo_unidad_stock_id_fkey" FOREIGN KEY ("unidad_stock_id") REFERENCES catalogos.unidad_medida ("id") ON UPDATE CASCADE ON DELETE RESTRICT;
DROP TABLE inventario.unidad_stock;

COMMENT ON COLUMN inventario.articulo.unidad_stock_id IS 'Unidad de medida (catalogos.unidad_medida, catálogo compartido de la plataforma) en que se lleva el stock del artículo.';
