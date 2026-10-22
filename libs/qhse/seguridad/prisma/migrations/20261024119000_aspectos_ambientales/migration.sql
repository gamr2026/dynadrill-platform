-- QHSE, aspectos ambientales (AspectoAmbiental de la demo, MATRIZ DE ASPECTOS AMBIENTALES Rev00): una fila por aspecto o actividad evaluada, con su
-- identificación, la valoración del riesgo ambiental (probabilidad × consecuencia), el control y el seguimiento. Misma lógica que el IPERC pero para impacto
-- ambiental. La demo guardaba casi todo como texto libre; aquí el proceso es el del IPERC (FK), la etapa y el factor son catálogos, los conjuntos fijos
-- son enums y el seguimiento son registros fechados que no se reescriben. Una fila dada de baja queda congelada.

CREATE TYPE "clasificacion_aspecto" AS ENUM ('bajo', 'moderado', 'alto');
CREATE TYPE "condicion_operacion_aspecto" AS ENUM ('normal', 'anormal', 'emergencia');
CREATE TYPE "tipo_responsabilidad_aspecto" AS ENUM ('directa', 'indirecta');
CREATE TYPE "tipo_impacto_aspecto" AS ENUM ('positivo', 'negativo');
CREATE TYPE "estado_control_aspecto" AS ENUM ('pendiente', 'en_ejecucion', 'implementado');
CREATE TYPE "estado_aspecto" AS ENUM ('vigente', 'dado_de_baja');

CREATE TABLE "aspecto_etapa_ciclo_vida" (
    "id" UUID NOT NULL,
    "codigo" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "orden" INTEGER NOT NULL,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_by" UUID,
    CONSTRAINT "aspecto_etapa_ciclo_vida_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "aspecto_etapa_ciclo_vida_codigo_key" UNIQUE ("codigo"),
    CONSTRAINT "aspecto_etapa_ciclo_vida_orden_key" UNIQUE ("orden"),
    CONSTRAINT "aspecto_etapa_ciclo_vida_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "aspecto_etapa_ciclo_vida_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id"));
COMMENT ON TABLE "aspecto_etapa_ciclo_vida" IS 'Etapas del ciclo de vida (ISO 14001) en que se evalúa un aspecto. Valores iniciales de referencia: QHSE los ajusta a su matriz.';

CREATE TABLE "aspecto_factor_ambiental" (
    "id" UUID NOT NULL,
    "codigo" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "orden" INTEGER NOT NULL,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_by" UUID,
    CONSTRAINT "aspecto_factor_ambiental_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "aspecto_factor_ambiental_codigo_key" UNIQUE ("codigo"),
    CONSTRAINT "aspecto_factor_ambiental_orden_key" UNIQUE ("orden"),
    CONSTRAINT "aspecto_factor_ambiental_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "aspecto_factor_ambiental_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id"));
COMMENT ON TABLE "aspecto_factor_ambiental" IS 'Factor ambiental afectado por el impacto (agua, aire, suelo…). Valores iniciales de referencia: QHSE los ajusta a su matriz.';

CREATE TABLE "aspecto_ambiental" (
    "id" UUID NOT NULL,
    "numero" INTEGER GENERATED ALWAYS AS IDENTITY,
    -- identificación
    "fecha" DATE NOT NULL,
    "etapa_id" UUID NOT NULL,
    "proceso_id" UUID NOT NULL,
    "actividad" TEXT NOT NULL,
    "produccion_del_aspecto" TEXT,
    "riesgo_gestion" TEXT,
    "aspecto" TEXT NOT NULL,
    "impacto" TEXT NOT NULL,
    "factor_id" UUID,
    "condicion_operacion" "condicion_operacion_aspecto",
    "tipo_responsabilidad" "tipo_responsabilidad_aspecto",
    "tipo_impacto" "tipo_impacto_aspecto",
    -- valoración del riesgo ambiental (el nivel = probabilidad × consecuencia se calcula, no se guarda)
    "fecha_valoracion" DATE,
    "probabilidad" SMALLINT NOT NULL,
    "consecuencia" SMALLINT NOT NULL,
    "clasificacion" "clasificacion_aspecto" NOT NULL,
    -- control del aspecto e impacto
    "ncar" TEXT,
    "plan_accion_existente" TEXT,
    "plan_tratamiento" TEXT,
    "responsable_id" UUID,
    "presupuesto" DECIMAL(14,2),
    "plazo" DATE,
    "estado_control" "estado_control_aspecto" NOT NULL DEFAULT 'pendiente',
    -- seguimiento y monitoreo (los registros van en `aspecto_ambiental_seguimiento`)
    "seguimiento_indicador" TEXT,
    "seguimiento_responsable_id" UUID,
    "seguimiento_frecuencia_id" UUID,
    -- baja
    "estado" "estado_aspecto" NOT NULL DEFAULT 'vigente',
    "baja_at" TIMESTAMPTZ(6),
    "baja_por" UUID,
    "baja_motivo" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_by" UUID,
    CONSTRAINT "aspecto_ambiental_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "aspecto_ambiental_etapa_fkey" FOREIGN KEY ("etapa_id") REFERENCES "aspecto_etapa_ciclo_vida" ("id"),
    CONSTRAINT "aspecto_ambiental_proceso_fkey" FOREIGN KEY ("proceso_id") REFERENCES "iperc_proceso" ("id"),
    CONSTRAINT "aspecto_ambiental_factor_fkey" FOREIGN KEY ("factor_id") REFERENCES "aspecto_factor_ambiental" ("id"),
    CONSTRAINT "aspecto_ambiental_responsable_fkey" FOREIGN KEY ("responsable_id") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "aspecto_ambiental_seg_responsable_fkey" FOREIGN KEY ("seguimiento_responsable_id") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "aspecto_ambiental_seg_frecuencia_fkey" FOREIGN KEY ("seguimiento_frecuencia_id") REFERENCES "frecuencia_seguimiento" ("id"),
    CONSTRAINT "aspecto_ambiental_baja_por_fkey" FOREIGN KEY ("baja_por") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "aspecto_ambiental_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "aspecto_ambiental_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "aspecto_ambiental_texto_check" CHECK (
      length(btrim("actividad")) > 0 AND length(btrim("aspecto")) > 0 AND length(btrim("impacto")) > 0),
    CONSTRAINT "aspecto_ambiental_valoracion_check" CHECK ("probabilidad" BETWEEN 1 AND 5 AND "consecuencia" BETWEEN 1 AND 5),
    CONSTRAINT "aspecto_ambiental_presupuesto_check" CHECK ("presupuesto" IS NULL OR "presupuesto" >= 0),
    -- una fila dada de baja dice cuándo, quién y por qué; una vigente no
    CONSTRAINT "aspecto_ambiental_baja_check" CHECK (
      ("estado" = 'vigente' AND "baja_at" IS NULL AND "baja_por" IS NULL AND "baja_motivo" IS NULL)
      OR ("estado" = 'dado_de_baja' AND "baja_at" IS NOT NULL AND "baja_por" IS NOT NULL AND length(btrim(coalesce("baja_motivo", ''))) > 0)));
CREATE UNIQUE INDEX "aspecto_ambiental_numero_key" ON "aspecto_ambiental" ("numero");
CREATE INDEX "aspecto_ambiental_clasificacion_idx" ON "aspecto_ambiental" ("clasificacion") WHERE "estado" = 'vigente';
CREATE INDEX "aspecto_ambiental_proceso_idx" ON "aspecto_ambiental" ("proceso_id");
CREATE INDEX "aspecto_ambiental_plazo_idx" ON "aspecto_ambiental" ("plazo") WHERE "estado" = 'vigente' AND "estado_control" <> 'implementado';

COMMENT ON TABLE "aspecto_ambiental" IS 'Aspecto e impacto ambiental de una actividad (MATRIZ DE ASPECTOS AMBIENTALES Rev00). Consecutivo ASP-000001. Nivel de riesgo = probabilidad × consecuencia (calculado).';
COMMENT ON COLUMN "aspecto_ambiental"."proceso_id" IS 'Proceso de la matriz IPERC (misma lógica actividad → riesgo). FK al catálogo de procesos del IPERC (mismo esquema).';
COMMENT ON COLUMN "aspecto_ambiental"."clasificacion" IS 'Bajo, moderado o alto: la elige quien evalúa, como en la demo. Los rangos de probabilidad × consecuencia que la determinan no están confirmados con Dynadrill, por eso no se derivan.';
COMMENT ON COLUMN "aspecto_ambiental"."ncar" IS 'Referencia de la no conformidad o acción correctiva/preventiva asociada, tal como la escribe QHSE (texto del formato).';
COMMENT ON COLUMN "aspecto_ambiental"."condicion_operacion" IS 'Condición de operación en que se da el aspecto (normal, anormal o emergencia). Valores de la norma ISO 14001; pendiente de cotejar con el formato.';

CREATE TABLE "aspecto_ambiental_seguimiento" (
    "id" UUID NOT NULL,
    "aspecto_id" UUID NOT NULL,
    "fecha" DATE NOT NULL,
    "eficaz" BOOLEAN NOT NULL,
    "observacion" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "created_by" UUID NOT NULL,
    CONSTRAINT "aspecto_ambiental_seguimiento_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "aspecto_ambiental_seguimiento_aspecto_fkey" FOREIGN KEY ("aspecto_id") REFERENCES "aspecto_ambiental" ("id"),
    CONSTRAINT "aspecto_ambiental_seguimiento_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "aspecto_ambiental_seguimiento_texto_check" CHECK (length(btrim("observacion")) > 0));
CREATE INDEX "aspecto_ambiental_seguimiento_idx" ON "aspecto_ambiental_seguimiento" ("aspecto_id", "fecha");
COMMENT ON TABLE "aspecto_ambiental_seguimiento" IS 'Registros de seguimiento de un aspecto: si los controles fueron eficaces (sí o no) y la observación. Inmutables; reemplazan los textos de «eficacia» y «estado» de la demo.';

-- Reglas: nace vigente; solo pasa de vigente a dado de baja; dado de baja queda congelado.
CREATE FUNCTION "aspecto_ambiental_validar"() RETURNS trigger LANGUAGE plpgsql SET search_path = qhse, pg_catalog AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."estado" <> 'vigente' THEN RAISE EXCEPTION 'Un aspecto ambiental nace vigente' USING ERRCODE = 'check_violation'; END IF;
    RETURN NEW;
  END IF;
  IF OLD."estado" = 'dado_de_baja' THEN
    RAISE EXCEPTION 'El aspecto ambiental está dado de baja y no admite cambios' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "aspecto_ambiental_validar_trg" BEFORE INSERT OR UPDATE ON "aspecto_ambiental" FOR EACH ROW EXECUTE FUNCTION "aspecto_ambiental_validar"();

CREATE FUNCTION "aspecto_ambiental_seguimiento_editable"() RETURNS trigger LANGUAGE plpgsql SET search_path = qhse, pg_catalog AS $$
DECLARE v_estado "estado_aspecto";
BEGIN
  SELECT "estado" INTO v_estado FROM "aspecto_ambiental" WHERE "id" = NEW."aspecto_id";
  IF v_estado <> 'vigente' THEN
    RAISE EXCEPTION 'El aspecto ambiental está dado de baja y no admite cambios' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "aspecto_ambiental_seguimiento_editable_trg" BEFORE INSERT ON "aspecto_ambiental_seguimiento" FOR EACH ROW EXECUTE FUNCTION "aspecto_ambiental_seguimiento_editable"();

-- Privilegios mínimos: el aspecto no se borra (se da de baja); el seguimiento solo se agrega. Los catálogos los amplía la aplicación.
REVOKE UPDATE ON "aspecto_ambiental" FROM app_qhse;
GRANT UPDATE ("fecha", "etapa_id", "proceso_id", "actividad", "produccion_del_aspecto", "riesgo_gestion", "aspecto", "impacto", "factor_id", "condicion_operacion",
              "tipo_responsabilidad", "tipo_impacto", "fecha_valoracion", "probabilidad", "consecuencia", "clasificacion", "ncar", "plan_accion_existente",
              "plan_tratamiento", "responsable_id", "presupuesto", "plazo", "estado_control", "seguimiento_indicador", "seguimiento_responsable_id",
              "seguimiento_frecuencia_id", "estado", "baja_at", "baja_por", "baja_motivo", "updated_at", "updated_by") ON "aspecto_ambiental" TO app_qhse;
REVOKE DELETE ON "aspecto_ambiental" FROM app_qhse;
REVOKE UPDATE, DELETE ON "aspecto_ambiental_seguimiento" FROM app_qhse;
-- el proceso es el catálogo del IPERC (mismo esquema, tabla de otra rebanada): la aplicación solo lo lee
GRANT SELECT ON "iperc_proceso" TO app_qhse;
