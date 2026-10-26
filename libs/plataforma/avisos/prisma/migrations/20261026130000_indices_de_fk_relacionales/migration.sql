-- Auditoría de la base (26/10/2026): índices en las FK relacionales (las que se filtran o se unen). PostgreSQL no indexa por sí solo la
-- columna que referencia; sin índice, listar «lo de la bodega X» o «los tickets del cliente Y» recorre toda la tabla. Las FK de auditoría
-- (created_by, updated_by...) no se indexan: nadie filtra por ellas.
CREATE INDEX IF NOT EXISTS "correo_aviso_regla_id_idx" ON "avisos"."correo_aviso" ("regla_id");
