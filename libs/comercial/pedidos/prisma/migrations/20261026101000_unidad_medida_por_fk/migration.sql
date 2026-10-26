-- CM-4 (PARIDAD-MODELO-DEMO.md): la unidad de la lista de precios, de los ítems del pedido y de las herramientas de los
-- documentos operativos deja de ser texto libre ("Unidad"/"unidad", "gls", "lbs"...) y pasa a ser FK a catalogos.unidad_medida.
-- Requiere la migración de catálogos 20261026100000_unidades_de_servicio. La prefactura, la OT y la guía conservan la unidad
-- como texto: son documentos emitidos y guardan lo que se imprimió.

-- Traducción de las escrituras que usaban las listas (salieron de la demo): por alias, por nombre o por símbolo
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

-- Lista de precios
ALTER TABLE "comercial"."lista_precios_item" ADD COLUMN "unidad_medida_id" UUID;
UPDATE "comercial"."lista_precios_item" SET "unidad_medida_id" = pg_temp.unidad_de_texto("unidad");

-- Ítems del pedido: la unidad de su línea de la lista; si la línea no viene de la lista, la del texto
ALTER TABLE "comercial"."pedido_item" ADD COLUMN "unidad_medida_id" UUID;
UPDATE "comercial"."pedido_item" p
   SET "unidad_medida_id" = coalesce(
         (SELECT l."unidad_medida_id" FROM "comercial"."lista_precios_item" l WHERE l."id" = p."lista_precios_item_id"),
         pg_temp.unidad_de_texto(p."unidad"));

-- Herramientas de los documentos operativos (la unidad es opcional: los reportes anteriores no la traían)
ALTER TABLE "comercial"."documento_operativo_herramienta" ADD COLUMN "unidad_medida_id" UUID;
UPDATE "comercial"."documento_operativo_herramienta"
   SET "unidad_medida_id" = pg_temp.unidad_de_texto("unidad")
 WHERE "unidad" IS NOT NULL;

-- Nada queda sin traducir: si aparece una escritura desconocida, la migración se detiene y la nombra
DO $$
DECLARE faltan text;
BEGIN
  SELECT string_agg(DISTINCT t, ', ') INTO faltan FROM (
    SELECT "unidad" t FROM "comercial"."lista_precios_item" WHERE "unidad_medida_id" IS NULL
    UNION SELECT "unidad" FROM "comercial"."pedido_item" WHERE "unidad_medida_id" IS NULL
    UNION SELECT "unidad" FROM "comercial"."documento_operativo_herramienta"
     WHERE "unidad" IS NOT NULL AND "unidad_medida_id" IS NULL
  ) x;
  IF faltan IS NOT NULL THEN
    RAISE EXCEPTION 'Unidades sin equivalente en catalogos.unidad_medida: %. Agréguelas al catálogo y repita.', faltan;
  END IF;
END $$;

ALTER TABLE "comercial"."lista_precios_item"
  ALTER COLUMN "unidad_medida_id" SET NOT NULL,
  ADD CONSTRAINT "lista_precios_item_unidad_medida_id_fkey"
    FOREIGN KEY ("unidad_medida_id") REFERENCES "catalogos"."unidad_medida"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  DROP COLUMN "unidad";
ALTER TABLE "comercial"."pedido_item"
  ALTER COLUMN "unidad_medida_id" SET NOT NULL,
  ADD CONSTRAINT "pedido_item_unidad_medida_id_fkey"
    FOREIGN KEY ("unidad_medida_id") REFERENCES "catalogos"."unidad_medida"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  DROP COLUMN "unidad";
ALTER TABLE "comercial"."documento_operativo_herramienta"
  ADD CONSTRAINT "documento_operativo_herramienta_unidad_medida_id_fkey"
    FOREIGN KEY ("unidad_medida_id") REFERENCES "catalogos"."unidad_medida"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  DROP COLUMN "unidad";

CREATE INDEX "lista_precios_item_unidad_medida_id_idx" ON "comercial"."lista_precios_item"("unidad_medida_id");
CREATE INDEX "pedido_item_unidad_medida_id_idx" ON "comercial"."pedido_item"("unidad_medida_id");

COMMENT ON COLUMN "comercial"."lista_precios_item"."unidad_medida_id" IS 'Unidad del catálogo compartido (CM-4), administrado en el portal: la fija la lista de precios.';
COMMENT ON COLUMN "comercial"."pedido_item"."unidad_medida_id" IS 'Unidad del catálogo compartido; la de su línea de la lista de precios.';
COMMENT ON COLUMN "comercial"."documento_operativo_herramienta"."unidad_medida_id" IS 'Unidad del ítem según el reporte de herramientas (nula en reportes anteriores).';
