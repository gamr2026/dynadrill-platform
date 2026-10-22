-- QHSE, investigación de incidentes, rebanada 4: acciones correctivas y preventivas (DYN-SGI-RE-034). Se registran con la investigación en curso, pero
-- su seguimiento sigue después del cierre (el formato: «finaliza investigación, seguimiento de planes de acción»). Estados: pendiente → implementada →
-- verificada (con la verificación de eficacia) o cancelada con motivo. Una acción no se borra: queda su historia.

CREATE TYPE "tipo_accion_investigacion" AS ENUM ('correctiva', 'preventiva');
CREATE TYPE "estado_accion_investigacion" AS ENUM ('pendiente', 'implementada', 'verificada', 'cancelada');
-- P/D · F · M · T del formato: a qué nivel de la jerarquía de control aplica la medida
CREATE TYPE "nivel_control_accion" AS ENUM ('planeacion_diseno', 'fuente', 'medio', 'trabajador');

CREATE TABLE "investigacion_accion" (
    "id" UUID NOT NULL,
    "investigacion_id" UUID NOT NULL,
    "orden" INTEGER NOT NULL,
    "descripcion" TEXT NOT NULL,
    "tipo" "tipo_accion_investigacion" NOT NULL,
    "responsable_id" UUID NOT NULL,
    "plazo" DATE NOT NULL,
    "estado" "estado_accion_investigacion" NOT NULL DEFAULT 'pendiente',
    "implementada_at" TIMESTAMPTZ(6),
    "implementada_por" UUID,
    "fue_eficaz" BOOLEAN,
    "verificacion_observacion" TEXT,
    "verificada_at" TIMESTAMPTZ(6),
    "verificada_por" UUID,
    "cancelada_at" TIMESTAMPTZ(6),
    "cancelada_por" UUID,
    "cancelacion_motivo" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_by" UUID,
    CONSTRAINT "investigacion_accion_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "investigacion_accion_investigacion_fkey" FOREIGN KEY ("investigacion_id") REFERENCES "investigacion" ("id"),
    CONSTRAINT "investigacion_accion_responsable_fkey" FOREIGN KEY ("responsable_id") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "investigacion_accion_implementada_por_fkey" FOREIGN KEY ("implementada_por") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "investigacion_accion_verificada_por_fkey" FOREIGN KEY ("verificada_por") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "investigacion_accion_cancelada_por_fkey" FOREIGN KEY ("cancelada_por") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "investigacion_accion_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "investigacion_accion_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "investigacion_accion_orden_key" UNIQUE ("investigacion_id", "orden"),
    CONSTRAINT "investigacion_accion_orden_check" CHECK ("orden" >= 1),
    CONSTRAINT "investigacion_accion_texto_check" CHECK (length(btrim("descripcion")) > 0),
    -- cada estado trae sus datos y nada de los siguientes
    CONSTRAINT "investigacion_accion_estado_check" CHECK (
      ("estado" = 'pendiente'
        AND "implementada_at" IS NULL AND "implementada_por" IS NULL
        AND "fue_eficaz" IS NULL AND "verificacion_observacion" IS NULL AND "verificada_at" IS NULL AND "verificada_por" IS NULL
        AND "cancelada_at" IS NULL AND "cancelada_por" IS NULL AND "cancelacion_motivo" IS NULL)
      OR ("estado" = 'implementada'
        AND "implementada_at" IS NOT NULL AND "implementada_por" IS NOT NULL
        AND "fue_eficaz" IS NULL AND "verificacion_observacion" IS NULL AND "verificada_at" IS NULL AND "verificada_por" IS NULL
        AND "cancelada_at" IS NULL AND "cancelada_por" IS NULL AND "cancelacion_motivo" IS NULL)
      OR ("estado" = 'verificada'
        AND "implementada_at" IS NOT NULL AND "implementada_por" IS NOT NULL
        AND "fue_eficaz" IS NOT NULL AND "verificada_at" IS NOT NULL AND "verificada_por" IS NOT NULL AND "verificada_at" >= "implementada_at"
        -- una acción que no resultó eficaz explica por qué
        AND ("fue_eficaz" OR length(btrim(coalesce("verificacion_observacion", ''))) > 0)
        AND "cancelada_at" IS NULL AND "cancelada_por" IS NULL AND "cancelacion_motivo" IS NULL)
      OR ("estado" = 'cancelada'
        AND "implementada_at" IS NULL AND "implementada_por" IS NULL
        AND "fue_eficaz" IS NULL AND "verificacion_observacion" IS NULL AND "verificada_at" IS NULL AND "verificada_por" IS NULL
        AND "cancelada_at" IS NOT NULL AND "cancelada_por" IS NOT NULL AND length(btrim(coalesce("cancelacion_motivo", ''))) > 0)));
CREATE INDEX "investigacion_accion_investigacion_idx" ON "investigacion_accion" ("investigacion_id");
CREATE INDEX "investigacion_accion_responsable_idx" ON "investigacion_accion" ("responsable_id") WHERE "estado" IN ('pendiente', 'implementada');
CREATE INDEX "investigacion_accion_plazo_idx" ON "investigacion_accion" ("plazo") WHERE "estado" = 'pendiente';

COMMENT ON TABLE "investigacion_accion" IS 'Acción correctiva o preventiva de una investigación (DYN-SGI-RE-034). El seguimiento continúa después del cierre de la investigación. No se borra: se cancela con motivo.';
COMMENT ON COLUMN "investigacion_accion"."plazo" IS 'Fecha límite para implementar la acción. Insumo del aviso de acciones vencidas.';
COMMENT ON COLUMN "investigacion_accion"."fue_eficaz" IS 'Verificación de eficacia: el formato indica hacerla luego de tres meses de implementada. La base no bloquea una verificación anterior (regla sin confirmar con Dynadrill); el detalle expone la fecha desde la que corresponde.';

CREATE TABLE "investigacion_accion_control" (
    "accion_id" UUID NOT NULL,
    "nivel" "nivel_control_accion" NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "created_by" UUID NOT NULL,
    CONSTRAINT "investigacion_accion_control_pkey" PRIMARY KEY ("accion_id", "nivel"),
    CONSTRAINT "investigacion_accion_control_accion_fkey" FOREIGN KEY ("accion_id") REFERENCES "investigacion_accion" ("id"),
    CONSTRAINT "investigacion_accion_control_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"));
COMMENT ON TABLE "investigacion_accion_control" IS 'Niveles de control a los que aplica la acción (P/D, F, M, T del formato): una fila por nivel marcado.';

CREATE TABLE "investigacion_accion_historial" (
    "id" UUID NOT NULL,
    "accion_id" UUID NOT NULL,
    "estado_anterior" "estado_accion_investigacion",
    "estado_nuevo" "estado_accion_investigacion" NOT NULL,
    "observacion" TEXT,
    "actor_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "investigacion_accion_historial_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "investigacion_accion_historial_accion_fkey" FOREIGN KEY ("accion_id") REFERENCES "investigacion_accion" ("id"),
    CONSTRAINT "investigacion_accion_historial_actor_fkey" FOREIGN KEY ("actor_id") REFERENCES identidad.usuario ("id"));
CREATE INDEX "investigacion_accion_historial_idx" ON "investigacion_accion_historial" ("accion_id", "created_at");

-- ---------------------------------------------------------------------------------------------------------------
-- Reglas de la acción
-- ---------------------------------------------------------------------------------------------------------------
CREATE FUNCTION "investigacion_accion_validar"() RETURNS trigger LANGUAGE plpgsql SET search_path = qhse, pg_catalog AS $$
DECLARE v_estado "estado_investigacion";
BEGIN
  SELECT "estado" INTO v_estado FROM "investigacion" WHERE "id" = NEW."investigacion_id";
  IF TG_OP = 'INSERT' THEN
    IF NEW."estado" <> 'pendiente' THEN RAISE EXCEPTION 'Una acción nace pendiente' USING ERRCODE = 'check_violation'; END IF;
    IF v_estado <> 'en_investigacion' THEN
      RAISE EXCEPTION 'Solo se registran acciones con la investigación en curso' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."investigacion_id" <> OLD."investigacion_id" OR NEW."orden" <> OLD."orden" THEN
    RAISE EXCEPTION 'La investigación y el número de la acción no se cambian' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."estado" = OLD."estado" THEN
    IF (NEW."descripcion" <> OLD."descripcion" OR NEW."tipo" <> OLD."tipo" OR NEW."responsable_id" <> OLD."responsable_id" OR NEW."plazo" <> OLD."plazo")
       AND (OLD."estado" <> 'pendiente' OR v_estado <> 'en_investigacion') THEN
      RAISE EXCEPTION 'La acción ya no se edita: solo una acción pendiente de una investigación en curso' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF (OLD."estado" = 'pendiente' AND NEW."estado" IN ('implementada', 'cancelada')) OR (OLD."estado" = 'implementada' AND NEW."estado" = 'verificada') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Cambio de estado no permitido: de % a %', OLD."estado", NEW."estado" USING ERRCODE = 'check_violation';
END
$$;
CREATE TRIGGER "investigacion_accion_validar_trg" BEFORE INSERT OR UPDATE ON "investigacion_accion" FOR EACH ROW EXECUTE FUNCTION "investigacion_accion_validar"();

-- Los niveles de control solo cambian mientras la acción está pendiente y la investigación en curso.
CREATE FUNCTION "investigacion_accion_control_editable"() RETURNS trigger LANGUAGE plpgsql SET search_path = qhse, pg_catalog AS $$
DECLARE v_accion UUID; v_estado "estado_accion_investigacion"; v_inv "estado_investigacion";
BEGIN
  v_accion := CASE WHEN TG_OP = 'DELETE' THEN OLD."accion_id" ELSE NEW."accion_id" END;
  SELECT a."estado", i."estado" INTO v_estado, v_inv FROM "investigacion_accion" a JOIN "investigacion" i ON i."id" = a."investigacion_id" WHERE a."id" = v_accion;
  IF v_estado <> 'pendiente' OR v_inv <> 'en_investigacion' THEN
    RAISE EXCEPTION 'La acción ya no se edita: solo una acción pendiente de una investigación en curso' USING ERRCODE = 'check_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
CREATE TRIGGER "investigacion_accion_control_editable_trg" BEFORE INSERT OR UPDATE OR DELETE ON "investigacion_accion_control" FOR EACH ROW EXECUTE FUNCTION "investigacion_accion_control_editable"();

-- Privilegios mínimos: la acción no se borra y solo cambian su contenido (mientras pendiente), su estado y los datos de cada paso; los niveles de control
-- se reemplazan (DELETE solo ahí); el historial solo se agrega.
REVOKE UPDATE ON "investigacion_accion" FROM app_qhse;
GRANT UPDATE ("descripcion", "tipo", "responsable_id", "plazo", "estado", "implementada_at", "implementada_por", "fue_eficaz", "verificacion_observacion",
              "verificada_at", "verificada_por", "cancelada_at", "cancelada_por", "cancelacion_motivo", "updated_at", "updated_by") ON "investigacion_accion" TO app_qhse;
REVOKE DELETE ON "investigacion_accion" FROM app_qhse;
REVOKE UPDATE ON "investigacion_accion_control" FROM app_qhse;
GRANT DELETE ON "investigacion_accion_control" TO app_qhse;
REVOKE UPDATE, DELETE ON "investigacion_accion_historial" FROM app_qhse;
