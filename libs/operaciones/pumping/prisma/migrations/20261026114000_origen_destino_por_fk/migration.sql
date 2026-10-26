-- OP-4 (PARIDAD-MODELO-DEMO.md): el origen y el destino del reporte de unidad dejan de ser texto y pasan a ser FK a una bodega o a un pozo,
-- igual que el viaje de Flota (`flota.gerenciamiento_viaje`): cada extremo es una bodega o un pozo, no ambos.
ALTER TABLE "reporte_unidad"
  ADD COLUMN "origen_bodega_id" UUID,
  ADD COLUMN "origen_pozo_id" UUID,
  ADD COLUMN "destino_bodega_id" UUID,
  ADD COLUMN "destino_pozo_id" UUID;

-- los textos escritos se enlazan por nombre (o código del pozo)
UPDATE "reporte_unidad" r SET "origen_bodega_id" = b."id" FROM catalogos.bodega b
 WHERE lower(btrim(b."nombre")) = lower(btrim(r."origen"));
UPDATE "reporte_unidad" r SET "origen_pozo_id" = p."id" FROM catalogos.pozo p
 WHERE r."origen_bodega_id" IS NULL
   AND (lower(btrim(p."nombre_completo")) = lower(btrim(r."origen")) OR lower(btrim(p."codigo")) = lower(btrim(r."origen")));
UPDATE "reporte_unidad" r SET "destino_bodega_id" = b."id" FROM catalogos.bodega b
 WHERE lower(btrim(b."nombre")) = lower(btrim(r."destino"));
UPDATE "reporte_unidad" r SET "destino_pozo_id" = p."id" FROM catalogos.pozo p
 WHERE r."destino_bodega_id" IS NULL
   AND (lower(btrim(p."nombre_completo")) = lower(btrim(r."destino")) OR lower(btrim(p."codigo")) = lower(btrim(r."destino")));

DO $$
DECLARE faltan text;
BEGIN
  SELECT string_agg(DISTINCT t, ', ') INTO faltan FROM (
    SELECT "origen" t FROM "pumping"."reporte_unidad" WHERE btrim(COALESCE("origen", '')) <> '' AND "origen_bodega_id" IS NULL AND "origen_pozo_id" IS NULL
    UNION SELECT "destino" FROM "pumping"."reporte_unidad" WHERE btrim(COALESCE("destino", '')) <> '' AND "destino_bodega_id" IS NULL AND "destino_pozo_id" IS NULL
  ) x;
  IF faltan IS NOT NULL THEN
    RAISE EXCEPTION 'Orígenes o destinos sin bodega ni pozo en el catálogo: %. Agréguelos al catálogo y repita.', faltan;
  END IF;
END $$;

ALTER TABLE "reporte_unidad"
  ADD CONSTRAINT "reporte_unidad_origen_bodega_id_fkey" FOREIGN KEY ("origen_bodega_id") REFERENCES catalogos.bodega ("id"),
  ADD CONSTRAINT "reporte_unidad_origen_pozo_id_fkey" FOREIGN KEY ("origen_pozo_id") REFERENCES catalogos.pozo ("id"),
  ADD CONSTRAINT "reporte_unidad_destino_bodega_id_fkey" FOREIGN KEY ("destino_bodega_id") REFERENCES catalogos.bodega ("id"),
  ADD CONSTRAINT "reporte_unidad_destino_pozo_id_fkey" FOREIGN KEY ("destino_pozo_id") REFERENCES catalogos.pozo ("id"),
  ADD CONSTRAINT "reporte_unidad_origen_check" CHECK (num_nonnulls("origen_bodega_id", "origen_pozo_id") <= 1),
  ADD CONSTRAINT "reporte_unidad_destino_check" CHECK (num_nonnulls("destino_bodega_id", "destino_pozo_id") <= 1),
  DROP COLUMN "origen",
  DROP COLUMN "destino";
COMMENT ON COLUMN "reporte_unidad"."origen_bodega_id" IS 'Origen del traslado si es una bodega (o `origen_pozo_id` si es un pozo). Se llena al firmar la salida.';
COMMENT ON COLUMN "reporte_unidad"."destino_bodega_id" IS 'Destino del traslado si es una bodega (o `destino_pozo_id` si es un pozo). Se llena al firmar la salida.';
