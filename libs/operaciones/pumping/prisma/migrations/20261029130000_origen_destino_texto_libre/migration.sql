-- Punto 8 de la prueba de flujos (28/10/2026): el origen y el destino del reporte de unidad vuelven a ser TEXTO LIBRE, como en la demo.
-- No son bodegas: pueden ser una base, un pozo, una ciudad o cualquier lugar. Se conserva lo ya registrado (nombre de la bodega o del pozo).
ALTER TABLE "reporte_unidad"
  ADD COLUMN "origen" TEXT,
  ADD COLUMN "destino" TEXT;

UPDATE "reporte_unidad" r SET "origen" = COALESCE(b."nombre", p."nombre_completo")
  FROM (SELECT r2."id", r2."origen_bodega_id", r2."origen_pozo_id" FROM "reporte_unidad" r2) x
  LEFT JOIN catalogos.bodega b ON b."id" = x."origen_bodega_id"
  LEFT JOIN catalogos.pozo p ON p."id" = x."origen_pozo_id"
 WHERE r."id" = x."id";
UPDATE "reporte_unidad" r SET "destino" = COALESCE(b."nombre", p."nombre_completo")
  FROM (SELECT r2."id", r2."destino_bodega_id", r2."destino_pozo_id" FROM "reporte_unidad" r2) x
  LEFT JOIN catalogos.bodega b ON b."id" = x."destino_bodega_id"
  LEFT JOIN catalogos.pozo p ON p."id" = x."destino_pozo_id"
 WHERE r."id" = x."id";

ALTER TABLE "reporte_unidad"
  DROP CONSTRAINT "reporte_unidad_origen_check",
  DROP CONSTRAINT "reporte_unidad_destino_check",
  DROP COLUMN "origen_bodega_id",
  DROP COLUMN "origen_pozo_id",
  DROP COLUMN "destino_bodega_id",
  DROP COLUMN "destino_pozo_id",
  ADD CONSTRAINT "reporte_unidad_origen_texto_check" CHECK ("origen" IS NULL OR btrim("origen") <> ''),
  ADD CONSTRAINT "reporte_unidad_destino_texto_check" CHECK ("destino" IS NULL OR btrim("destino") <> '');
COMMENT ON COLUMN "reporte_unidad"."origen" IS 'Origen del traslado (texto libre: base, pozo, ciudad…). Se llena al firmar la salida.';
COMMENT ON COLUMN "reporte_unidad"."destino" IS 'Destino del traslado (texto libre). Se llena al firmar la salida.';
