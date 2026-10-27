-- Búsqueda parcial (ILIKE '%texto%') por código de pedido en la copia de tickets de QHSE: índice GIN con pg_trgm (db/init/05-extensiones.sql).
CREATE INDEX IF NOT EXISTS ticket_ref_pedido_codigo_trgm_idx ON qhse.ticket_ref USING gin (pedido_codigo public.gin_trgm_ops);
