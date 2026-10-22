-- QHSE, investigación de incidentes (DYN-SGI-RE-034, HSE-TRIAGE-002), rebanada 1: núcleo. La investigación se abre, se asegura la escena y se
-- nombra al líder; lo demás del formato (trabajador, testigos, entorno, causas, acciones, cierre) llega en las rebanadas siguientes, cada una
-- con su propia migración. El resultado del incidente es un catálogo con sus plazos, no un texto: los plazos se ajustan sin migrar.

CREATE TYPE "estado_investigacion" AS ENUM ('abierta', 'en_investigacion', 'en_revision', 'cerrada');

-- ---------------------------------------------------------------------------------------------------------------
-- Catálogo de resultados del incidente y sus plazos (HSE-TRIAGE-002)
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE "investigacion_resultado" (
    "id" UUID NOT NULL,
    "codigo" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "orden" INTEGER NOT NULL,
    "inicio_horas" INTEGER NOT NULL,
    "preliminar_horas" INTEGER,
    "final_dias" INTEGER NOT NULL,
    "plazo_supuesto" BOOLEAN NOT NULL DEFAULT false,
    "involucra_lesionado" BOOLEAN NOT NULL,
    "sugiere_notificacion_legal" BOOLEAN NOT NULL,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_by" UUID,
    CONSTRAINT "investigacion_resultado_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "investigacion_resultado_codigo_key" UNIQUE ("codigo"),
    CONSTRAINT "investigacion_resultado_orden_key" UNIQUE ("orden"),
    CONSTRAINT "investigacion_resultado_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "investigacion_resultado_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "investigacion_resultado_plazos_check" CHECK (
      "inicio_horas" >= 0 AND "final_dias" > 0 AND ("preliminar_horas" IS NULL OR "preliminar_horas" >= 0)));

COMMENT ON TABLE "investigacion_resultado" IS 'Resultado del incidente (fatal, grave, leve, near miss…) con los plazos de HSE-TRIAGE-002: inicio de la investigación, informe preliminar y informe final.';
COMMENT ON COLUMN "investigacion_resultado"."plazo_supuesto" IS 'true si el documento no tabula el plazo de este resultado y se adoptó el de «leve» (supuesto de la demo): pendiente de confirmar con Dynadrill.';
COMMENT ON COLUMN "investigacion_resultado"."involucra_lesionado" IS 'Si hay una persona lesionada: solo entonces la investigación lleva «datos del trabajador involucrado».';
COMMENT ON COLUMN "investigacion_resultado"."sugiere_notificacion_legal" IS 'Si corresponde sugerir la notificación a Ministerio del Trabajo e IESS (plazo de 24 h).';

-- ---------------------------------------------------------------------------------------------------------------
-- La investigación
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE "investigacion" (
    "id" UUID NOT NULL,
    "numero" INTEGER GENERATED ALWAYS AS IDENTITY,
    "resultado_id" UUID NOT NULL,
    "descripcion_evento" TEXT NOT NULL,
    "fecha_incidente" TIMESTAMPTZ(6) NOT NULL,
    "ubicacion" TEXT NOT NULL,
    "origen_emergencia_id" UUID,
    "estado" "estado_investigacion" NOT NULL DEFAULT 'abierta',
    "lider_id" UUID,
    "escena_asegurada_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_by" UUID,
    CONSTRAINT "investigacion_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "investigacion_resultado_fkey" FOREIGN KEY ("resultado_id") REFERENCES "investigacion_resultado" ("id"),
    CONSTRAINT "investigacion_lider_fkey" FOREIGN KEY ("lider_id") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "investigacion_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "investigacion_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "investigacion_texto_check" CHECK (length(btrim("descripcion_evento")) > 0 AND length(btrim("ubicacion")) > 0),
    -- cada estado trae sus datos: la investigación en curso tiene líder y escena asegurada. Las rebanadas siguientes agregan en_revision y cerrada.
    CONSTRAINT "investigacion_estado_check" CHECK (
      ("estado" = 'abierta' AND "lider_id" IS NULL AND "escena_asegurada_at" IS NULL)
      OR ("estado" = 'en_investigacion' AND "lider_id" IS NOT NULL AND "escena_asegurada_at" IS NOT NULL)));
CREATE UNIQUE INDEX "investigacion_numero_key" ON "investigacion" ("numero");
CREATE INDEX "investigacion_estado_idx" ON "investigacion" ("estado");
CREATE INDEX "investigacion_fecha_idx" ON "investigacion" ("fecha_incidente");
CREATE INDEX "investigacion_resultado_idx" ON "investigacion" ("resultado_id");
-- una emergencia origina a lo sumo una investigación (cuando exista la tabla de emergencias de QHSE se le agrega su FK)
CREATE UNIQUE INDEX "investigacion_origen_emergencia_key" ON "investigacion" ("origen_emergencia_id") WHERE "origen_emergencia_id" IS NOT NULL;

COMMENT ON TABLE "investigacion" IS 'Investigación de incidente o accidente (DYN-SGI-RE-034). Consecutivo INV-000001. Los plazos no se guardan: se calculan con el catálogo de resultados.';
COMMENT ON COLUMN "investigacion"."origen_emergencia_id" IS 'Emergencia (Nivel 2/3) que originó la investigación. Id sin FK por ahora: la tabla de emergencias es de otra sesión; se le agrega la FK al integrarla (mismo esquema).';
COMMENT ON COLUMN "investigacion"."escena_asegurada_at" IS 'Cuándo se aseguró la escena; el plazo de inicio de la investigación se mide contra este momento.';

CREATE TABLE "investigacion_historial" (
    "id" UUID NOT NULL, "investigacion_id" UUID NOT NULL,
    "estado_anterior" "estado_investigacion", "estado_nuevo" "estado_investigacion" NOT NULL,
    "observacion" TEXT, "actor_id" UUID NOT NULL, "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "investigacion_historial_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "investigacion_historial_investigacion_fkey" FOREIGN KEY ("investigacion_id") REFERENCES "investigacion" ("id"),
    CONSTRAINT "investigacion_historial_actor_fkey" FOREIGN KEY ("actor_id") REFERENCES identidad.usuario ("id"));
CREATE INDEX "investigacion_historial_idx" ON "investigacion_historial" ("investigacion_id", "created_at");

-- Reglas del ciclo. En esta rebanada solo existe abierta → en_investigacion; las demás transiciones se agregan con su rebanada.
CREATE FUNCTION "investigacion_validar"() RETURNS trigger LANGUAGE plpgsql SET search_path = qhse, pg_catalog AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."estado" <> 'abierta' THEN RAISE EXCEPTION 'Una investigación nace abierta' USING ERRCODE = 'check_violation'; END IF;
    RETURN NEW;
  END IF;
  IF NEW."resultado_id" <> OLD."resultado_id" OR NEW."fecha_incidente" <> OLD."fecha_incidente"
     OR NEW."descripcion_evento" <> OLD."descripcion_evento" OR NEW."ubicacion" <> OLD."ubicacion"
     OR NEW."origen_emergencia_id" IS DISTINCT FROM OLD."origen_emergencia_id" THEN
    RAISE EXCEPTION 'El resultado, la fecha, la descripción, la ubicación y el origen del incidente no se cambian' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."estado" = OLD."estado" THEN RETURN NEW; END IF;
  IF OLD."estado" = 'abierta' AND NEW."estado" = 'en_investigacion' THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Cambio de estado no permitido: de % a %', OLD."estado", NEW."estado" USING ERRCODE = 'check_violation';
END
$$;
CREATE TRIGGER "investigacion_validar_trg" BEFORE INSERT OR UPDATE ON "investigacion" FOR EACH ROW EXECUTE FUNCTION "investigacion_validar"();

-- Privilegios mínimos: lo reportado no se reescribe; solo avanzan el estado, el líder y la escena. No se borra nada; el historial solo se agrega.
REVOKE UPDATE ON "investigacion" FROM app_qhse;
GRANT UPDATE ("estado", "lider_id", "escena_asegurada_at", "updated_at", "updated_by") ON "investigacion" TO app_qhse;
REVOKE DELETE ON "investigacion" FROM app_qhse;
REVOKE UPDATE, DELETE ON "investigacion_historial" FROM app_qhse;
