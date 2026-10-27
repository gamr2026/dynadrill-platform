-- Corte de la demo (27/10/2026): la migración inicial de listas de precios desde la demo ya no se repite; se retira `legacy_id`.
ALTER TABLE comercial.lista_precios DROP COLUMN IF EXISTS legacy_id;
