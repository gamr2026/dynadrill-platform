-- Categoría de repuestos y suministros de mantenimiento: Mantenimiento ofrece sus artículos al registrar el repuesto usado en una
-- sub-orden. El comportamiento depende de esta marca, nunca del nombre de la categoría (la semilla la enciende en la categoría de AS2).
ALTER TABLE "categoria_articulo" ADD COLUMN "es_repuesto" BOOLEAN NOT NULL DEFAULT false;
COMMENT ON COLUMN "categoria_articulo"."es_repuesto" IS 'Los artículos de la categoría son repuestos y suministros de mantenimiento. El comportamiento depende de esta marca, nunca del nombre.';
