-- Corte de la demo (27/10/2026): la plataforma ya no traduce tokens ni asigna por los ids numéricos del backend demo.
-- Se retira el puente de identidad: el id numérico de cada rol y usuario (y su índice único).
ALTER TABLE identidad.rol DROP COLUMN IF EXISTS legacy_id;
ALTER TABLE identidad.usuario DROP COLUMN IF EXISTS legacy_id;
