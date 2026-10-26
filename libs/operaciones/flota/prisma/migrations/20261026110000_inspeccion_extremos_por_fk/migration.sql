-- FL-3 (PARIDAD-MODELO-DEMO.md): el punto de partida y el destino de la inspección de vehículo dejan de ser texto y pasan a ser FK a una
-- bodega o a un pozo, como ya lo son el origen y el destino del viaje (`gerenciamiento_viaje`). El de partida es obligatorio; el destino, no.
ALTER TABLE "inspeccion_vehiculo"
  ADD COLUMN "partida_bodega_id" UUID,
  ADD COLUMN "partida_pozo_id" UUID,
  ADD COLUMN "destino_bodega_id" UUID,
  ADD COLUMN "destino_pozo_id" UUID;

-- los textos escritos se enlazan por nombre (o código del pozo)
UPDATE "inspeccion_vehiculo" i SET "partida_bodega_id" = b."id" FROM catalogos.bodega b
 WHERE lower(btrim(b."nombre")) = lower(btrim(i."punto_partida"));
UPDATE "inspeccion_vehiculo" i SET "partida_pozo_id" = p."id" FROM catalogos.pozo p
 WHERE i."partida_bodega_id" IS NULL
   AND (lower(btrim(p."nombre_completo")) = lower(btrim(i."punto_partida")) OR lower(btrim(p."codigo")) = lower(btrim(i."punto_partida")));
UPDATE "inspeccion_vehiculo" i SET "destino_bodega_id" = b."id" FROM catalogos.bodega b
 WHERE lower(btrim(b."nombre")) = lower(btrim(i."destino"));
UPDATE "inspeccion_vehiculo" i SET "destino_pozo_id" = p."id" FROM catalogos.pozo p
 WHERE i."destino_bodega_id" IS NULL
   AND (lower(btrim(p."nombre_completo")) = lower(btrim(i."destino")) OR lower(btrim(p."codigo")) = lower(btrim(i."destino")));

DO $$
DECLARE faltan text;
BEGIN
  SELECT string_agg(DISTINCT t, ', ') INTO faltan FROM (
    SELECT "punto_partida" t FROM "flota"."inspeccion_vehiculo" WHERE "partida_bodega_id" IS NULL AND "partida_pozo_id" IS NULL
    UNION SELECT "destino" FROM "flota"."inspeccion_vehiculo" WHERE btrim(COALESCE("destino", '')) <> '' AND "destino_bodega_id" IS NULL AND "destino_pozo_id" IS NULL
  ) x;
  IF faltan IS NOT NULL THEN
    RAISE EXCEPTION 'Puntos de partida o destinos sin bodega ni pozo en el catálogo: %. Agréguelos al catálogo y repita.', faltan;
  END IF;
END $$;

ALTER TABLE "inspeccion_vehiculo"
  ADD CONSTRAINT "inspeccion_vehiculo_partida_bodega_id_fkey" FOREIGN KEY ("partida_bodega_id") REFERENCES catalogos.bodega ("id"),
  ADD CONSTRAINT "inspeccion_vehiculo_partida_pozo_id_fkey" FOREIGN KEY ("partida_pozo_id") REFERENCES catalogos.pozo ("id"),
  ADD CONSTRAINT "inspeccion_vehiculo_destino_bodega_id_fkey" FOREIGN KEY ("destino_bodega_id") REFERENCES catalogos.bodega ("id"),
  ADD CONSTRAINT "inspeccion_vehiculo_destino_pozo_id_fkey" FOREIGN KEY ("destino_pozo_id") REFERENCES catalogos.pozo ("id"),
  ADD CONSTRAINT "inspeccion_vehiculo_partida_check" CHECK (num_nonnulls("partida_bodega_id", "partida_pozo_id") = 1),
  ADD CONSTRAINT "inspeccion_vehiculo_destino_check" CHECK (num_nonnulls("destino_bodega_id", "destino_pozo_id") <= 1),
  DROP COLUMN "punto_partida",
  DROP COLUMN "destino";
CREATE INDEX "inspeccion_vehiculo_partida_bodega_idx" ON "inspeccion_vehiculo" ("partida_bodega_id");
CREATE INDEX "inspeccion_vehiculo_partida_pozo_idx" ON "inspeccion_vehiculo" ("partida_pozo_id");
CREATE INDEX "inspeccion_vehiculo_destino_bodega_idx" ON "inspeccion_vehiculo" ("destino_bodega_id");
CREATE INDEX "inspeccion_vehiculo_destino_pozo_idx" ON "inspeccion_vehiculo" ("destino_pozo_id");
COMMENT ON COLUMN "inspeccion_vehiculo"."partida_bodega_id" IS 'Punto de partida si es una bodega (o `partida_pozo_id` si es un pozo): uno solo.';
COMMENT ON COLUMN "inspeccion_vehiculo"."destino_bodega_id" IS 'Destino si es una bodega (o `destino_pozo_id` si es un pozo): a lo más uno.';
