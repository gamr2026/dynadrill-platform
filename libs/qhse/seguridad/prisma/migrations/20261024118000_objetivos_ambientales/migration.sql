-- QHSE, objetivos ambientales (ObjetivoAmbiental de la demo, OBJETIVOS AMBIENTALES.xlsx): objetivo, meta, indicador, plazo y plan de acción, con su
-- seguimiento periódico y su cierre (cumplido o no cumplido). El plan de acción (un objeto en la demo) pasa a FILAS; el seguimiento, que la demo
-- guardaba como un par de textos sueltos («resultado» y «evidencia»), pasa a registros con fecha y avance, que no se reescriben.

CREATE TYPE "estado_objetivo_ambiental" AS ENUM ('en_curso', 'cumplido', 'no_cumplido');

-- Frecuencia con que se mide o ejecuta algo (plan de acción de un objetivo; seguimiento de un aspecto ambiental). Catálogo: QHSE lo amplía.
CREATE TABLE "frecuencia_seguimiento" (
    "id" UUID NOT NULL,
    "codigo" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "orden" INTEGER NOT NULL,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_by" UUID,
    CONSTRAINT "frecuencia_seguimiento_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "frecuencia_seguimiento_codigo_key" UNIQUE ("codigo"),
    CONSTRAINT "frecuencia_seguimiento_orden_key" UNIQUE ("orden"),
    CONSTRAINT "frecuencia_seguimiento_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "frecuencia_seguimiento_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id"));
COMMENT ON TABLE "frecuencia_seguimiento" IS 'Frecuencias de seguimiento (mensual, trimestral, semestral, anual). La demo las escribía como texto libre.';

CREATE TABLE "objetivo_ambiental" (
    "id" UUID NOT NULL,
    "numero" INTEGER GENERATED ALWAYS AS IDENTITY,
    "titulo" TEXT NOT NULL,
    "objetivo" TEXT NOT NULL,
    "meta" TEXT NOT NULL,
    "indicador" TEXT NOT NULL,
    "beneficio_empresarial" TEXT,
    "plazo" DATE,
    "estado" "estado_objetivo_ambiental" NOT NULL DEFAULT 'en_curso',
    "resultado" TEXT,
    "evidencia" TEXT,
    "cerrado_at" TIMESTAMPTZ(6),
    "cerrado_por" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_by" UUID,
    CONSTRAINT "objetivo_ambiental_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "objetivo_ambiental_cerrado_por_fkey" FOREIGN KEY ("cerrado_por") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "objetivo_ambiental_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "objetivo_ambiental_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "objetivo_ambiental_texto_check" CHECK (
      length(btrim("titulo")) > 0 AND length(btrim("objetivo")) > 0 AND length(btrim("meta")) > 0 AND length(btrim("indicador")) > 0),
    -- cada estado trae sus datos: un objetivo cerrado dice el resultado, quién y cuándo
    CONSTRAINT "objetivo_ambiental_estado_check" CHECK (
      ("estado" = 'en_curso' AND "resultado" IS NULL AND "evidencia" IS NULL AND "cerrado_at" IS NULL AND "cerrado_por" IS NULL)
      OR ("estado" IN ('cumplido', 'no_cumplido')
          AND length(btrim(coalesce("resultado", ''))) > 0 AND "cerrado_at" IS NOT NULL AND "cerrado_por" IS NOT NULL)));
CREATE UNIQUE INDEX "objetivo_ambiental_numero_key" ON "objetivo_ambiental" ("numero");
CREATE INDEX "objetivo_ambiental_estado_idx" ON "objetivo_ambiental" ("estado");
CREATE INDEX "objetivo_ambiental_plazo_idx" ON "objetivo_ambiental" ("plazo") WHERE "estado" = 'en_curso' AND "plazo" IS NOT NULL;
COMMENT ON TABLE "objetivo_ambiental" IS 'Objetivo del Sistema de Gestión Ambiental (revisión anual). Consecutivo OBJ-000001. Se cierra como cumplido o no cumplido, con su resultado.';

CREATE TABLE "objetivo_ambiental_accion" (
    "id" UUID NOT NULL,
    "objetivo_id" UUID NOT NULL,
    "orden" INTEGER NOT NULL,
    "accion_especifica" TEXT NOT NULL,
    "responsable_id" UUID,
    "indicador" TEXT,
    "evidencia_esperada" TEXT,
    "frecuencia_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_by" UUID,
    CONSTRAINT "objetivo_ambiental_accion_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "objetivo_ambiental_accion_objetivo_fkey" FOREIGN KEY ("objetivo_id") REFERENCES "objetivo_ambiental" ("id"),
    CONSTRAINT "objetivo_ambiental_accion_responsable_fkey" FOREIGN KEY ("responsable_id") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "objetivo_ambiental_accion_frecuencia_fkey" FOREIGN KEY ("frecuencia_id") REFERENCES "frecuencia_seguimiento" ("id"),
    CONSTRAINT "objetivo_ambiental_accion_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "objetivo_ambiental_accion_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "objetivo_ambiental_accion_orden_key" UNIQUE ("objetivo_id", "orden"),
    CONSTRAINT "objetivo_ambiental_accion_orden_check" CHECK ("orden" >= 1),
    CONSTRAINT "objetivo_ambiental_accion_texto_check" CHECK (length(btrim("accion_especifica")) > 0));
COMMENT ON TABLE "objetivo_ambiental_accion" IS 'Plan de acción del objetivo: una acción específica por fila, con su responsable (cuenta del portal), frecuencia y evidencia esperada.';

CREATE TABLE "objetivo_ambiental_seguimiento" (
    "id" UUID NOT NULL,
    "objetivo_id" UUID NOT NULL,
    "fecha" DATE NOT NULL,
    "avance_porcentaje" SMALLINT NOT NULL,
    "observacion" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "created_by" UUID NOT NULL,
    CONSTRAINT "objetivo_ambiental_seguimiento_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "objetivo_ambiental_seguimiento_objetivo_fkey" FOREIGN KEY ("objetivo_id") REFERENCES "objetivo_ambiental" ("id"),
    CONSTRAINT "objetivo_ambiental_seguimiento_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "objetivo_ambiental_seguimiento_avance_check" CHECK ("avance_porcentaje" BETWEEN 0 AND 100),
    CONSTRAINT "objetivo_ambiental_seguimiento_texto_check" CHECK (length(btrim("observacion")) > 0));
CREATE INDEX "objetivo_ambiental_seguimiento_idx" ON "objetivo_ambiental_seguimiento" ("objetivo_id", "fecha");
COMMENT ON TABLE "objetivo_ambiental_seguimiento" IS 'Registros de seguimiento del objetivo (fecha, avance y observación). Inmutables: un error se corrige con un registro nuevo.';

-- Reglas del objetivo: nace en curso; solo pasa de en_curso a cumplido o no cumplido; cerrado queda congelado.
CREATE FUNCTION "objetivo_ambiental_validar"() RETURNS trigger LANGUAGE plpgsql SET search_path = qhse, pg_catalog AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."estado" <> 'en_curso' THEN RAISE EXCEPTION 'Un objetivo ambiental nace en curso' USING ERRCODE = 'check_violation'; END IF;
    RETURN NEW;
  END IF;
  IF OLD."estado" <> 'en_curso' THEN
    RAISE EXCEPTION 'El objetivo ya está cerrado y no admite cambios' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "objetivo_ambiental_validar_trg" BEFORE INSERT OR UPDATE ON "objetivo_ambiental" FOR EACH ROW EXECUTE FUNCTION "objetivo_ambiental_validar"();

-- El plan de acción y el seguimiento solo se tocan con el objetivo en curso.
CREATE FUNCTION "objetivo_ambiental_hijo_editable"() RETURNS trigger LANGUAGE plpgsql SET search_path = qhse, pg_catalog AS $$
DECLARE v_estado "estado_objetivo_ambiental";
BEGIN
  SELECT "estado" INTO v_estado FROM "objetivo_ambiental" WHERE "id" = CASE WHEN TG_OP = 'DELETE' THEN OLD."objetivo_id" ELSE NEW."objetivo_id" END;
  IF v_estado <> 'en_curso' THEN
    RAISE EXCEPTION 'El objetivo ya está cerrado y no admite cambios' USING ERRCODE = 'check_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
CREATE TRIGGER "objetivo_ambiental_accion_editable_trg" BEFORE INSERT OR UPDATE OR DELETE ON "objetivo_ambiental_accion" FOR EACH ROW EXECUTE FUNCTION "objetivo_ambiental_hijo_editable"();
CREATE TRIGGER "objetivo_ambiental_seguimiento_editable_trg" BEFORE INSERT ON "objetivo_ambiental_seguimiento" FOR EACH ROW EXECUTE FUNCTION "objetivo_ambiental_hijo_editable"();

-- Privilegios mínimos: el objetivo no se borra; las acciones se reemplazan (DELETE solo ahí); el seguimiento solo se agrega.
REVOKE UPDATE ON "objetivo_ambiental" FROM app_qhse;
GRANT UPDATE ("titulo", "objetivo", "meta", "indicador", "beneficio_empresarial", "plazo", "estado", "resultado", "evidencia", "cerrado_at", "cerrado_por",
              "updated_at", "updated_by") ON "objetivo_ambiental" TO app_qhse;
REVOKE DELETE ON "objetivo_ambiental" FROM app_qhse;
GRANT DELETE ON "objetivo_ambiental_accion" TO app_qhse;
REVOKE UPDATE, DELETE ON "objetivo_ambiental_seguimiento" FROM app_qhse;
