-- Auditoría de la base (26/10/2026): referencia polimórfica.
COMMENT ON COLUMN "cambio"."entidad_id" IS 'Id de la entidad que cambió según `entidad_tipo` (varias tablas, de otros contenedores): sin FK.';
