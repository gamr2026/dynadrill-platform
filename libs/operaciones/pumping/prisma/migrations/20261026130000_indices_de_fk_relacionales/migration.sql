-- Auditoría de la base (26/10/2026): índices en las FK relacionales (las que se filtran o se unen). PostgreSQL no indexa por sí solo la
-- columna que referencia; sin índice, listar «lo de la bodega X» o «los tickets del cliente Y» recorre toda la tabla. Las FK de auditoría
-- (created_by, updated_by...) no se indexan: nadie filtra por ellas.
CREATE INDEX IF NOT EXISTS "ticket_cliente_id_idx" ON "pumping"."ticket" ("cliente_id");
CREATE INDEX IF NOT EXISTS "ticket_pozo_id_idx" ON "pumping"."ticket" ("pozo_id");
CREATE INDEX IF NOT EXISTS "ticket_campo_id_idx" ON "pumping"."ticket" ("campo_id");
CREATE INDEX IF NOT EXISTS "ticket_requisito_requisito_codigo_idx" ON "pumping"."ticket_requisito" ("requisito_codigo");
CREATE INDEX IF NOT EXISTS "ticket_requisito_usuario_id_idx" ON "pumping"."ticket_requisito" ("usuario_id");
