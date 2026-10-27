-- Búsqueda parcial (ILIKE '%texto%') de clientes y pozos: índices GIN con pg_trgm (la extensión la crea db/init/05-extensiones.sql).
CREATE INDEX IF NOT EXISTS cliente_nombre_comercial_trgm_idx ON catalogos.cliente USING gin (nombre_comercial public.gin_trgm_ops);
CREATE INDEX IF NOT EXISTS pozo_nombre_completo_trgm_idx ON catalogos.pozo USING gin (nombre_completo public.gin_trgm_ops);
