-- Búsqueda parcial (ILIKE '%texto%') de pedidos por código: índice GIN con pg_trgm (db/init/05-extensiones.sql).
CREATE INDEX IF NOT EXISTS pedido_codigo_trgm_idx ON comercial.pedido USING gin (codigo public.gin_trgm_ops);
