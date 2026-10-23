-- QHSE, investigación de incidentes, rebanada 3: análisis de causas. Los 5 Porqués, las causas del diagrama de Ishikawa y las causas del formato
-- (actos inseguros, condiciones inseguras, factores personales, factores de trabajo y causas de fuente de gestión) son FILAS, no JSON ni un texto por
-- columna: así cada causa se puede listar, contar y ligar a una acción. Se editan con la investigación abierta o en investigación (mismo trigger).

CREATE TYPE "tipo_causa_investigacion" AS ENUM ('acto_inseguro', 'condicion_insegura', 'factor_personal', 'factor_trabajo', 'fuente_gestion');

-- ---------------------------------------------------------------------------------------------------------------
-- Catálogo de las categorías (las 6 M) del diagrama de Ishikawa
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE "ishikawa_categoria" (
    "id" UUID NOT NULL,
    "codigo" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "orden" INTEGER NOT NULL,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_by" UUID,
    CONSTRAINT "ishikawa_categoria_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ishikawa_categoria_codigo_key" UNIQUE ("codigo"),
    CONSTRAINT "ishikawa_categoria_orden_key" UNIQUE ("orden"),
    CONSTRAINT "ishikawa_categoria_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "ishikawa_categoria_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id"));
COMMENT ON TABLE "ishikawa_categoria" IS 'Categorías (6 M) del diagrama de Ishikawa: mano de obra, método, máquina, material, medioambiente y medición.';

-- ---------------------------------------------------------------------------------------------------------------
-- 5 Porqués, causas de Ishikawa y causas del formato
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE "investigacion_porque" (
    "id" UUID NOT NULL,
    "investigacion_id" UUID NOT NULL,
    "orden" INTEGER NOT NULL,
    "pregunta" TEXT NOT NULL,
    "respuesta" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_by" UUID,
    CONSTRAINT "investigacion_porque_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "investigacion_porque_investigacion_fkey" FOREIGN KEY ("investigacion_id") REFERENCES "investigacion" ("id"),
    CONSTRAINT "investigacion_porque_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "investigacion_porque_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "investigacion_porque_orden_key" UNIQUE ("investigacion_id", "orden"),
    -- la técnica pide al menos 5 niveles; se permiten hasta 10 si hace falta profundizar
    CONSTRAINT "investigacion_porque_orden_check" CHECK ("orden" BETWEEN 1 AND 10),
    CONSTRAINT "investigacion_porque_texto_check" CHECK (length(btrim("pregunta")) > 0 AND length(btrim("respuesta")) > 0));
COMMENT ON TABLE "investigacion_porque" IS 'Técnica de los 5 Porqués: un nivel por fila (orden 1 = el más cercano al evento). El cierre exige al menos 5.';

CREATE TABLE "investigacion_ishikawa_causa" (
    "id" UUID NOT NULL,
    "investigacion_id" UUID NOT NULL,
    "categoria_id" UUID NOT NULL,
    "orden" INTEGER NOT NULL,
    "descripcion" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_by" UUID,
    CONSTRAINT "investigacion_ishikawa_causa_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "investigacion_ishikawa_causa_investigacion_fkey" FOREIGN KEY ("investigacion_id") REFERENCES "investigacion" ("id"),
    CONSTRAINT "investigacion_ishikawa_causa_categoria_fkey" FOREIGN KEY ("categoria_id") REFERENCES "ishikawa_categoria" ("id"),
    CONSTRAINT "investigacion_ishikawa_causa_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "investigacion_ishikawa_causa_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "investigacion_ishikawa_causa_orden_key" UNIQUE ("investigacion_id", "orden"),
    CONSTRAINT "investigacion_ishikawa_causa_orden_check" CHECK ("orden" >= 1),
    CONSTRAINT "investigacion_ishikawa_causa_texto_check" CHECK (length(btrim("descripcion")) > 0));
CREATE INDEX "investigacion_ishikawa_causa_categoria_idx" ON "investigacion_ishikawa_causa" ("categoria_id");
COMMENT ON TABLE "investigacion_ishikawa_causa" IS 'Causas del diagrama de Ishikawa: una por fila, con su categoría (varias causas por categoría).';

CREATE TABLE "investigacion_causa" (
    "id" UUID NOT NULL,
    "investigacion_id" UUID NOT NULL,
    "tipo" "tipo_causa_investigacion" NOT NULL,
    "orden" INTEGER NOT NULL,
    "descripcion" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_by" UUID,
    CONSTRAINT "investigacion_causa_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "investigacion_causa_investigacion_fkey" FOREIGN KEY ("investigacion_id") REFERENCES "investigacion" ("id"),
    CONSTRAINT "investigacion_causa_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "investigacion_causa_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "investigacion_causa_orden_key" UNIQUE ("investigacion_id", "tipo", "orden"),
    CONSTRAINT "investigacion_causa_orden_check" CHECK ("orden" >= 1),
    CONSTRAINT "investigacion_causa_texto_check" CHECK (length(btrim("descripcion")) > 0));
COMMENT ON TABLE "investigacion_causa" IS 'Causas del formato DYN-SGI-RE-034 (actos inseguros, condiciones inseguras, factores personales, factores de trabajo, fuente de gestión), una por fila. Reemplaza el texto único «causas raíz» de la demo.';

-- Solo se editan con la investigación abierta o en investigación (misma regla que el formato de campo).
CREATE TRIGGER "investigacion_porque_editable_trg" BEFORE INSERT OR UPDATE OR DELETE ON "investigacion_porque" FOR EACH ROW EXECUTE FUNCTION "investigacion_hijo_editable"();
CREATE TRIGGER "investigacion_ishikawa_causa_editable_trg" BEFORE INSERT OR UPDATE OR DELETE ON "investigacion_ishikawa_causa" FOR EACH ROW EXECUTE FUNCTION "investigacion_hijo_editable"();
CREATE TRIGGER "investigacion_causa_editable_trg" BEFORE INSERT OR UPDATE OR DELETE ON "investigacion_causa" FOR EACH ROW EXECUTE FUNCTION "investigacion_hijo_editable"();

-- Las tres listas se reemplazan completas al guardar: la aplicación necesita DELETE solo en ellas.
GRANT DELETE ON "investigacion_porque", "investigacion_ishikawa_causa", "investigacion_causa" TO app_qhse;
