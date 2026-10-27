-- Búsqueda parcial (ILIKE '%texto%') de artículos por código y nombre: índices GIN con pg_trgm (db/init/05-extensiones.sql).
CREATE INDEX IF NOT EXISTS articulo_codigo_trgm_idx ON inventario.articulo USING gin (codigo public.gin_trgm_ops);
CREATE INDEX IF NOT EXISTS articulo_nombre_trgm_idx ON inventario.articulo USING gin (nombre public.gin_trgm_ops);
