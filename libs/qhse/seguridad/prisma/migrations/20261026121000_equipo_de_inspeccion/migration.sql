-- QH-1 (PARIDAD-MODELO-DEMO.md): el equipo inspeccionado deja de ser un texto que escribe quien inspecciona y pasa a ser un catálogo. Con texto
-- libre `EXT-01` y `ext 01` eran dos equipos y el indicador «% de inspecciones vigentes» los contaba por separado. El equipo se da de alta
-- desde el mismo formulario de inspección. Es único por tipo y por código sin mayúsculas ni espacios (como agrupaba antes la consulta).
CREATE TABLE "equipo" (
    "id" UUID NOT NULL,
    "tipo_id" UUID NOT NULL,
    "codigo" TEXT NOT NULL,
    "descripcion" TEXT,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID NOT NULL,
    CONSTRAINT "equipo_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "equipo_tipo_fkey" FOREIGN KEY ("tipo_id") REFERENCES "inspeccion_tipo" ("id"),
    CONSTRAINT "equipo_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "equipo_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "equipo_codigo_check" CHECK (length(btrim("codigo")) > 0),
    CONSTRAINT "equipo_descripcion_check" CHECK ("descripcion" IS NULL OR length(btrim("descripcion")) > 0),
    -- para la FK compuesta de la inspección: el equipo es del mismo tipo que la inspección
    CONSTRAINT "equipo_id_tipo_key" UNIQUE ("id", "tipo_id")
);
CREATE UNIQUE INDEX "equipo_tipo_codigo_key" ON "equipo" ("tipo_id", lower(regexp_replace("codigo", '\s+', '', 'g')));
COMMENT ON TABLE "equipo" IS 'Equipo que se inspecciona (eslinga de cable, detector de gas, vehículo-grúa), de un tipo de inspección. Único por tipo y código sin mayúsculas ni espacios; se da de alta desde el formulario de inspección.';
COMMENT ON COLUMN "equipo"."codigo" IS 'Identificación física del equipo (n.º de la eslinga, serie del detector, código de la unidad), tal como se escribió la primera vez.';

-- los equipos que ya aparecen en las inspecciones (con la grafía de la más reciente)
INSERT INTO "equipo" ("id", "tipo_id", "codigo", "created_by", "updated_by", "created_at", "updated_at")
SELECT DISTINCT ON (i."tipo_id", lower(regexp_replace(i."equipo_codigo", '\s+', '', 'g')))
       gen_random_uuid(), i."tipo_id", btrim(i."equipo_codigo"), i."created_by", i."created_by", i."created_at", i."created_at"
  FROM "inspeccion" i
 ORDER BY i."tipo_id", lower(regexp_replace(i."equipo_codigo", '\s+', '', 'g')), i."fecha" DESC, i."numero" DESC;

ALTER TABLE "inspeccion" ADD COLUMN "equipo_id" UUID;
UPDATE "inspeccion" i SET "equipo_id" = e."id" FROM "equipo" e
 WHERE e."tipo_id" = i."tipo_id" AND lower(regexp_replace(e."codigo", '\s+', '', 'g')) = lower(regexp_replace(i."equipo_codigo", '\s+', '', 'g'));
ALTER TABLE "inspeccion"
  ALTER COLUMN "equipo_id" SET NOT NULL,
  -- la inspección y su equipo son del mismo tipo
  ADD CONSTRAINT "inspeccion_equipo_fkey" FOREIGN KEY ("equipo_id", "tipo_id") REFERENCES "equipo" ("id", "tipo_id"),
  DROP CONSTRAINT "inspeccion_equipo_check",
  DROP COLUMN "equipo_codigo";
DROP INDEX IF EXISTS "inspeccion_equipo_idx";
CREATE INDEX "inspeccion_equipo_idx" ON "inspeccion" ("equipo_id", "fecha" DESC);

-- la tarjeta STOP también puede señalar el equipo (la demo lo registra)
ALTER TABLE "stop_tarjeta"
  ADD COLUMN "equipo_id" UUID,
  ADD CONSTRAINT "stop_tarjeta_equipo_fkey" FOREIGN KEY ("equipo_id") REFERENCES "equipo" ("id");
CREATE INDEX "stop_tarjeta_equipo_idx" ON "stop_tarjeta" ("equipo_id");
COMMENT ON COLUMN "stop_tarjeta"."equipo_id" IS 'Equipo del catálogo al que se refiere la observación, si aplica.';
