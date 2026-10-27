-- Corte de la demo (27/10/2026): ningún módulo viejo referencia los catálogos por su id numérico. Se retira `legacy_id`
-- (y su índice único) de las seis tablas que lo conservaban.
ALTER TABLE catalogos.bloque DROP COLUMN IF EXISTS legacy_id;
ALTER TABLE catalogos.campo DROP COLUMN IF EXISTS legacy_id;
ALTER TABLE catalogos.taladro DROP COLUMN IF EXISTS legacy_id;
ALTER TABLE catalogos.pozo DROP COLUMN IF EXISTS legacy_id;
ALTER TABLE catalogos.cliente DROP COLUMN IF EXISTS legacy_id;
ALTER TABLE catalogos.persona_contacto DROP COLUMN IF EXISTS legacy_id;
