-- Punto 8 de la prueba de flujos (28/10/2026): el punto de partida y el destino de la inspección
-- vuelven a ser TEXTO LIBRE, como en la demo. No son bodegas: pueden ser una base, un pozo, una ciudad o cualquier lugar.
-- Se conserva lo ya registrado (nombre de la bodega o del pozo).

-- ---- inspección de vehículo ----
-- la inspección anulada es de solo lectura (trigger): se suspende un momento para completar el texto de las ya registradas
ALTER TABLE "inspeccion_vehiculo" DISABLE TRIGGER "inspeccion_vehiculo_anulacion_definitiva_trg";

ALTER TABLE "inspeccion_vehiculo"
  ADD COLUMN "punto_partida" TEXT,
  ADD COLUMN "destino" TEXT;

UPDATE "inspeccion_vehiculo" i SET "punto_partida" = COALESCE(b."nombre", p."nombre_completo")
  FROM (SELECT i2."id", i2."partida_bodega_id", i2."partida_pozo_id" FROM "inspeccion_vehiculo" i2) x
  LEFT JOIN catalogos.bodega b ON b."id" = x."partida_bodega_id"
  LEFT JOIN catalogos.pozo p ON p."id" = x."partida_pozo_id"
 WHERE i."id" = x."id";
UPDATE "inspeccion_vehiculo" i SET "destino" = COALESCE(b."nombre", p."nombre_completo")
  FROM (SELECT i2."id", i2."destino_bodega_id", i2."destino_pozo_id" FROM "inspeccion_vehiculo" i2) x
  LEFT JOIN catalogos.bodega b ON b."id" = x."destino_bodega_id"
  LEFT JOIN catalogos.pozo p ON p."id" = x."destino_pozo_id"
 WHERE i."id" = x."id";

ALTER TABLE "inspeccion_vehiculo" ENABLE TRIGGER "inspeccion_vehiculo_anulacion_definitiva_trg";

ALTER TABLE "inspeccion_vehiculo"
  DROP CONSTRAINT "inspeccion_vehiculo_partida_check",
  DROP CONSTRAINT "inspeccion_vehiculo_destino_check",
  DROP COLUMN "partida_bodega_id",
  DROP COLUMN "partida_pozo_id",
  DROP COLUMN "destino_bodega_id",
  DROP COLUMN "destino_pozo_id",
  ALTER COLUMN "punto_partida" SET NOT NULL,
  ADD CONSTRAINT "inspeccion_vehiculo_punto_partida_check" CHECK (btrim("punto_partida") <> ''),
  ADD CONSTRAINT "inspeccion_vehiculo_destino_texto_check" CHECK ("destino" IS NULL OR btrim("destino") <> '');
COMMENT ON COLUMN "inspeccion_vehiculo"."punto_partida" IS 'Punto de partida (texto libre, obligatorio): una base, un pozo, una ciudad…';
COMMENT ON COLUMN "inspeccion_vehiculo"."destino" IS 'Destino (texto libre, opcional).';
