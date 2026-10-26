-- Auditoría de la base (26/10/2026): índices en las FK relacionales (las que se filtran o se unen). PostgreSQL no indexa por sí solo la
-- columna que referencia; sin índice, listar «lo de la bodega X» o «los tickets del cliente Y» recorre toda la tabla. Las FK de auditoría
-- (created_by, updated_by...) no se indexan: nadie filtra por ellas.
CREATE INDEX IF NOT EXISTS "pedido_agente_comercial_id_idx" ON "comercial"."pedido" ("agente_comercial_id");
CREATE INDEX IF NOT EXISTS "pedido_tecnico_hse_id_idx" ON "comercial"."pedido" ("tecnico_hse_id");
CREATE INDEX IF NOT EXISTS "pedido_bodega_id_idx" ON "comercial"."pedido" ("bodega_id");
CREATE INDEX IF NOT EXISTS "pedido_taladro_id_idx" ON "comercial"."pedido" ("taladro_id");
CREATE INDEX IF NOT EXISTS "pedido_bloque_id_idx" ON "comercial"."pedido" ("bloque_id");
CREATE INDEX IF NOT EXISTS "pedido_item_lista_precios_item_id_idx" ON "comercial"."pedido_item" ("lista_precios_item_id");
CREATE INDEX IF NOT EXISTS "prefactura_lista_precios_id_idx" ON "comercial"."prefactura" ("lista_precios_id");
CREATE INDEX IF NOT EXISTS "pedido_tipo_servicio_tipo_id_idx" ON "comercial"."pedido_tipo_servicio" ("tipo_id");
CREATE INDEX IF NOT EXISTS "guia_remision_vehiculo_id_idx" ON "comercial"."guia_remision" ("vehiculo_id");
CREATE INDEX IF NOT EXISTS "guia_remision_chofer_id_idx" ON "comercial"."guia_remision" ("chofer_id");
CREATE INDEX IF NOT EXISTS "guia_remision_transportista_id_idx" ON "comercial"."guia_remision" ("transportista_id");
