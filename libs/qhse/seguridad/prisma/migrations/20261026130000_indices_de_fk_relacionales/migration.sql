-- Auditoría de la base (26/10/2026): índices en las FK relacionales (las que se filtran o se unen). PostgreSQL no indexa por sí solo la
-- columna que referencia; sin índice, listar «lo de la bodega X» o «los tickets del cliente Y» recorre toda la tabla. Las FK de auditoría
-- (created_by, updated_by...) no se indexan: nadie filtra por ellas.
CREATE INDEX IF NOT EXISTS "inspeccion_tipo_id_idx" ON "qhse"."inspeccion" ("tipo_id");
CREATE INDEX IF NOT EXISTS "inspeccion_inspector_id_idx" ON "qhse"."inspeccion" ("inspector_id");
CREATE INDEX IF NOT EXISTS "stop_tarjeta_observado_id_idx" ON "qhse"."stop_tarjeta" ("observado_id");
CREATE INDEX IF NOT EXISTS "stop_tarjeta_ticket_id_idx" ON "qhse"."stop_tarjeta" ("ticket_id");
CREATE INDEX IF NOT EXISTS "ptw_ticket_id_pedido_id_idx" ON "qhse"."ptw" ("ticket_id", "pedido_id");
CREATE INDEX IF NOT EXISTS "aspecto_ambiental_responsable_id_idx" ON "qhse"."aspecto_ambiental" ("responsable_id");
CREATE INDEX IF NOT EXISTS "investigacion_lider_id_idx" ON "qhse"."investigacion" ("lider_id");
CREATE INDEX IF NOT EXISTS "epi_entrega_item_elemento_id_idx" ON "qhse"."epi_entrega_item" ("elemento_id");
