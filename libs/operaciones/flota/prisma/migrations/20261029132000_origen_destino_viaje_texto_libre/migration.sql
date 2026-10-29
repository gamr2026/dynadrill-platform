-- Punto 8 de la prueba de flujos (28/10/2026), segunda parte: el origen y el destino del viaje vuelven a ser TEXTO LIBRE, como en la demo.
-- Se conserva lo ya registrado (nombre de la bodega o del pozo).
-- la decisión del viaje es definitiva (trigger): se suspende un momento para completar el texto de los ya registrados
ALTER TABLE "gerenciamiento_viaje" DISABLE TRIGGER "gerenciamiento_viaje_decision_definitiva_trg";

ALTER TABLE "gerenciamiento_viaje"
  ADD COLUMN IF NOT EXISTS "origen" TEXT,
  ADD COLUMN IF NOT EXISTS "destino" TEXT;

UPDATE "gerenciamiento_viaje" g SET "origen" = COALESCE(b."nombre", p."nombre_completo")
  FROM (SELECT g2."id", g2."origen_bodega_id", g2."origen_pozo_id" FROM "gerenciamiento_viaje" g2) x
  LEFT JOIN catalogos.bodega b ON b."id" = x."origen_bodega_id"
  LEFT JOIN catalogos.pozo p ON p."id" = x."origen_pozo_id"
 WHERE g."id" = x."id";
UPDATE "gerenciamiento_viaje" g SET "destino" = COALESCE(b."nombre", p."nombre_completo")
  FROM (SELECT g2."id", g2."destino_bodega_id", g2."destino_pozo_id" FROM "gerenciamiento_viaje" g2) x
  LEFT JOIN catalogos.bodega b ON b."id" = x."destino_bodega_id"
  LEFT JOIN catalogos.pozo p ON p."id" = x."destino_pozo_id"
 WHERE g."id" = x."id";

ALTER TABLE "gerenciamiento_viaje" ENABLE TRIGGER "gerenciamiento_viaje_decision_definitiva_trg";

ALTER TABLE "gerenciamiento_viaje"
  DROP CONSTRAINT "gerenciamiento_viaje_origen_check",
  DROP CONSTRAINT "gerenciamiento_viaje_destino_check",
  DROP COLUMN "origen_bodega_id",
  DROP COLUMN "origen_pozo_id",
  DROP COLUMN "destino_bodega_id",
  DROP COLUMN "destino_pozo_id",
  -- con ticket, el origen y el destino salen de la inspección de salida (pueden ir nulos); sin ella son texto obligatorio
  ADD CONSTRAINT "gerenciamiento_viaje_origen_check"
    CHECK (("origen" IS NOT NULL AND btrim("origen") <> '') OR ("inspeccion_id" IS NOT NULL AND "origen" IS NULL)),
  ADD CONSTRAINT "gerenciamiento_viaje_destino_check"
    CHECK (("destino" IS NOT NULL AND btrim("destino") <> '') OR ("inspeccion_id" IS NOT NULL AND "destino" IS NULL));
COMMENT ON COLUMN "gerenciamiento_viaje"."origen" IS 'Origen del viaje (texto libre). Con ticket queda vacío y se toma de la inspección de salida.';
COMMENT ON COLUMN "gerenciamiento_viaje"."destino" IS 'Destino del viaje (texto libre). Con ticket queda vacío y se toma de la inspección de salida.';
