-- OP-6 (PARIDAD-MODELO-DEMO.md): la unidad de las líneas del pedido, del Reporte de Herramientas y de las solicitudes de cambio
-- deja de ser texto copiado y pasa a ser FK a catalogos.unidad_medida (mismo catálogo que Comercial e Inventario). El catálogo
-- propio `unidad_cotizacion` (con `es_tiempo`) se retira: lo reemplaza `catalogos.unidad_medida.periodo`.
-- Requiere la migración de catálogos 20261026100000_unidades_de_servicio.

CREATE FUNCTION pg_temp.unidad_de_texto(t text) RETURNS uuid LANGUAGE sql STABLE AS $$
  WITH clave AS (SELECT lower(regexp_replace(btrim(t), '\s+', '', 'g')) AS k),
  alias(k, nombre) AS (VALUES
    ('gls', 'Galón'), ('gl', 'Galón'), ('lbs', 'Libra'), ('hr', 'Hora'), ('hrs', 'Hora'), ('sx', 'Saco'),
    ('hhp*hr', 'HHP·hora'), ('tn-km', 'Tonelada·kilómetro'), ('ton', 'Tonelada'), ('dia', 'Día'), ('dias', 'Día'),
    ('días', 'Día'), ('und', 'Unidad'), ('unidades', 'Unidad'), ('horas', 'Hora'), ('meses', 'Mes'), ('semanas', 'Semana'))
  SELECT u.id FROM catalogos.unidad_medida u, clave c
  WHERE lower(u.nombre) = c.k
     OR lower(regexp_replace(u.simbolo, '\s+', '', 'g')) = c.k
     OR lower(u.nombre) = (SELECT lower(a.nombre) FROM alias a WHERE a.k = c.k)
  ORDER BY (lower(u.nombre) = c.k) DESC
  LIMIT 1
$$;

-- las solicitudes de cambio son inmutables (disparador): se suspende solo para traducir la unidad
ALTER TABLE "fcr"."solicitud_cambio_item" DISABLE TRIGGER USER;

ALTER TABLE "fcr"."ticket_linea" ADD COLUMN "unidad_medida_id" UUID;
UPDATE "fcr"."ticket_linea" SET "unidad_medida_id" = pg_temp.unidad_de_texto("unidad");
ALTER TABLE "fcr"."reporte_item" ADD COLUMN "unidad_medida_id" UUID;
UPDATE "fcr"."reporte_item" SET "unidad_medida_id" = pg_temp.unidad_de_texto("unidad") WHERE "unidad" IS NOT NULL;
ALTER TABLE "fcr"."solicitud_cambio_item" ADD COLUMN "unidad_medida_id" UUID;
UPDATE "fcr"."solicitud_cambio_item" SET "unidad_medida_id" = pg_temp.unidad_de_texto("unidad");

DO $$
DECLARE faltan text;
BEGIN
  SELECT string_agg(DISTINCT t, ', ') INTO faltan FROM (
    SELECT "unidad" t FROM "fcr"."ticket_linea" WHERE "unidad_medida_id" IS NULL
    UNION SELECT "unidad" FROM "fcr"."reporte_item" WHERE "unidad" IS NOT NULL AND "unidad_medida_id" IS NULL
    UNION SELECT "unidad" FROM "fcr"."solicitud_cambio_item" WHERE "unidad_medida_id" IS NULL
  ) x;
  IF faltan IS NOT NULL THEN
    RAISE EXCEPTION 'Unidades sin equivalente en catalogos.unidad_medida: %. Agréguelas al catálogo y repita.', faltan;
  END IF;
END $$;

ALTER TABLE "fcr"."ticket_linea"
  ALTER COLUMN "unidad_medida_id" SET NOT NULL,
  ADD CONSTRAINT "ticket_linea_unidad_medida_id_fkey"
    FOREIGN KEY ("unidad_medida_id") REFERENCES "catalogos"."unidad_medida"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  DROP COLUMN "unidad";
ALTER TABLE "fcr"."reporte_item"
  ADD CONSTRAINT "reporte_item_unidad_medida_id_fkey"
    FOREIGN KEY ("unidad_medida_id") REFERENCES "catalogos"."unidad_medida"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  DROP COLUMN "unidad";
ALTER TABLE "fcr"."solicitud_cambio_item"
  ALTER COLUMN "unidad_medida_id" SET NOT NULL,
  ADD CONSTRAINT "solicitud_cambio_item_unidad_medida_id_fkey"
    FOREIGN KEY ("unidad_medida_id") REFERENCES "catalogos"."unidad_medida"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  DROP COLUMN "unidad";

ALTER TABLE "fcr"."solicitud_cambio_item" ENABLE TRIGGER USER;

CREATE INDEX "ticket_linea_unidad_medida_id_idx" ON "fcr"."ticket_linea"("unidad_medida_id");
CREATE INDEX "reporte_item_unidad_medida_id_idx" ON "fcr"."reporte_item"("unidad_medida_id");

DROP TABLE "fcr"."unidad_cotizacion";

COMMENT ON COLUMN "fcr"."ticket_linea"."unidad_medida_id" IS 'Unidad de la línea cotizada (catálogo compartido, la de la lista de precios). Su período decide si la línea es de tiempo (un solo juego del kit).';
COMMENT ON COLUMN "fcr"."reporte_item"."unidad_medida_id" IS 'Unidad de la fila (catálogo compartido). `por_dia` se fija al crear la fila: verdadero si la unidad tiene período día.';
