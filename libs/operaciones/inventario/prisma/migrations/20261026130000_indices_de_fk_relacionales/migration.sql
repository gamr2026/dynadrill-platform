-- Auditoría de la base (26/10/2026): índices en las FK relacionales (las que se filtran o se unen). PostgreSQL no indexa por sí solo la
-- columna que referencia; sin índice, listar «lo de la bodega X» o «los tickets del cliente Y» recorre toda la tabla. Las FK de auditoría
-- (created_by, updated_by...) no se indexan: nadie filtra por ellas.
CREATE INDEX IF NOT EXISTS "movimiento_bodega_id_idx" ON "inventario"."movimiento" ("bodega_id");
CREATE INDEX IF NOT EXISTS "movimiento_responsable_id_idx" ON "inventario"."movimiento" ("responsable_id");
CREATE INDEX IF NOT EXISTS "consumo_ticket_articulo_id_idx" ON "inventario"."consumo_ticket" ("articulo_id");
CREATE INDEX IF NOT EXISTS "despacho_bodega_id_idx" ON "inventario"."despacho" ("bodega_id");
CREATE INDEX IF NOT EXISTS "articulo_categoria_id_subcategoria_id_idx" ON "inventario"."articulo" ("categoria_id", "subcategoria_id");
