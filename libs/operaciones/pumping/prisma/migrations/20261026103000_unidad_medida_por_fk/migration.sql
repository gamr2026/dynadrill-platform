-- OP-6 (PARIDAD-MODELO-DEMO.md): la unidad de los ítems de una solicitud de cambio deja de ser texto copiado y pasa a ser FK a
-- catalogos.unidad_medida (mismo catálogo que Comercial, FCR e Inventario). Requiere la migración de catálogos
-- 20261026100000_unidades_de_servicio. (La unidad de `gas_limite` es la de medición del gas, ppm o %, y no cambia.)

CREATE FUNCTION pg_temp.unidad_de_texto(t text) RETURNS uuid LANGUAGE sql STABLE AS $$
  WITH clave AS (SELECT lower(regexp_replace(btrim(t), '\s+', '', 'g')) AS k),
  alias(k, nombre) AS (VALUES
    ('gls', 'Galón'), ('gl', 'Galón'), ('lbs', 'Libra'), ('hr', 'Hora'), ('hrs', 'Hora'), ('sx', 'Saco'),
    ('hhp*hr', 'HHP·hora'), ('tn-km', 'Tonelada·kilómetro'), ('ton', 'Tonelada'), ('dia', 'Día'), ('und', 'Unidad'))
  SELECT u.id FROM catalogos.unidad_medida u, clave c
  WHERE lower(u.nombre) = c.k
     OR lower(regexp_replace(u.simbolo, '\s+', '', 'g')) = c.k
     OR lower(u.nombre) = (SELECT lower(a.nombre) FROM alias a WHERE a.k = c.k)
  ORDER BY (lower(u.nombre) = c.k) DESC
  LIMIT 1
$$;

-- inmutable (disparador): se suspende solo para traducir la unidad
ALTER TABLE "pumping"."solicitud_cambio_item" DISABLE TRIGGER USER;
ALTER TABLE "pumping"."solicitud_cambio_item" ADD COLUMN "unidad_medida_id" UUID;
UPDATE "pumping"."solicitud_cambio_item" SET "unidad_medida_id" = pg_temp.unidad_de_texto("unidad");

DO $$
DECLARE faltan text;
BEGIN
  SELECT string_agg(DISTINCT "unidad", ', ') INTO faltan
    FROM "pumping"."solicitud_cambio_item" WHERE "unidad_medida_id" IS NULL;
  IF faltan IS NOT NULL THEN
    RAISE EXCEPTION 'Unidades sin equivalente en catalogos.unidad_medida: %. Agréguelas al catálogo y repita.', faltan;
  END IF;
END $$;

ALTER TABLE "pumping"."solicitud_cambio_item"
  ALTER COLUMN "unidad_medida_id" SET NOT NULL,
  ADD CONSTRAINT "solicitud_cambio_item_unidad_medida_id_fkey"
    FOREIGN KEY ("unidad_medida_id") REFERENCES "catalogos"."unidad_medida"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  DROP COLUMN "unidad";
ALTER TABLE "pumping"."solicitud_cambio_item" ENABLE TRIGGER USER;
