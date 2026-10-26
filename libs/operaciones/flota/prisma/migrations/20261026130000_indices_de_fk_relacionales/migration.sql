-- Auditoría de la base (26/10/2026): índices en las FK relacionales (las que se filtran o se unen). PostgreSQL no indexa por sí solo la
-- columna que referencia; sin índice, listar «lo de la bodega X» o «los tickets del cliente Y» recorre toda la tabla. Las FK de auditoría
-- (created_by, updated_by...) no se indexan: nadie filtra por ellas.
CREATE INDEX IF NOT EXISTS "gerenciamiento_viaje_unidad_id_idx" ON "flota"."gerenciamiento_viaje" ("unidad_id");
CREATE INDEX IF NOT EXISTS "inspeccion_caso_unidad_id_idx" ON "flota"."inspeccion_caso" ("unidad_id");
CREATE INDEX IF NOT EXISTS "inspeccion_vehiculo_caso_id_unidad_id_idx" ON "flota"."inspeccion_vehiculo" ("caso_id", "unidad_id");
