-- Extensiones de la base (las crea el superusuario; el rol de migraciones no puede):
--  pg_trgm: índices GIN para las búsquedas parciales (ILIKE '%texto%') de código y nombre.
--  pg_stat_statements: mide las consultas más lentas (requiere shared_preload_libraries, ver docker-compose.yml).
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
