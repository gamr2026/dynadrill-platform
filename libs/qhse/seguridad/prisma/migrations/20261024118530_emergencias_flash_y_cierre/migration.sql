-- QHSE, tramo Q5: Emergencias, Reporte Flash, controlada y cierre (HSE-TRIAGE-001). El Reporte Flash (resumen ejecutivo, personal afectado, acciones
-- tomadas, estado actual y próximos pasos) se emite una sola vez, completo, y su plazo de 2 horas desde la activación se informa sin bloquear.
-- La emergencia pasa a controlada y, de ahí, a cerrada: el cierre exige el Reporte Flash y el nivel declarado; en nivel 2 o 3 exige además
-- la investigación de incidentes (HSE-TRIAGE-002), comprobada solo si esa tabla existe en el esquema (es de otra sesión: la FK
-- `investigacion.origen_emergencia_id` → `emergencia` se agrega al integrar). Una emergencia cerrada ya no cambia.

CREATE TABLE "emergencia_reporte_flash" (
    "emergencia_id" UUID NOT NULL,
    "resumen_ejecutivo" TEXT NOT NULL,
    "personal_afectado" TEXT NOT NULL,
    "acciones_tomadas" TEXT NOT NULL,
    "estado_actual" TEXT NOT NULL,
    "proximos_pasos" TEXT NOT NULL,
    "emitido_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "emitido_por" UUID NOT NULL,
    CONSTRAINT "emergencia_reporte_flash_pkey" PRIMARY KEY ("emergencia_id"),
    CONSTRAINT "emergencia_reporte_flash_emergencia_fkey" FOREIGN KEY ("emergencia_id") REFERENCES "emergencia" ("id") ON DELETE CASCADE,
    CONSTRAINT "emergencia_reporte_flash_emitido_por_fkey" FOREIGN KEY ("emitido_por") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "emergencia_reporte_flash_completo_check" CHECK (
      length(btrim("resumen_ejecutivo")) > 0 AND length(btrim("personal_afectado")) > 0 AND length(btrim("acciones_tomadas")) > 0
      AND length(btrim("estado_actual")) > 0 AND length(btrim("proximos_pasos")) > 0)
);

ALTER TABLE "emergencia"
  ADD COLUMN "controlada_at" TIMESTAMPTZ(6),
  ADD COLUMN "controlada_por" UUID,
  ADD COLUMN "cerrada_at" TIMESTAMPTZ(6),
  ADD COLUMN "cerrada_por" UUID,
  ADD CONSTRAINT "emergencia_controlada_por_fkey" FOREIGN KEY ("controlada_por") REFERENCES identidad.usuario ("id"),
  ADD CONSTRAINT "emergencia_cerrada_por_fkey" FOREIGN KEY ("cerrada_por") REFERENCES identidad.usuario ("id"),
  -- cada estado trae sus datos: activa, ninguno; controlada, el de controlar; cerrada, el de controlar y el de cerrar
  ADD CONSTRAINT "emergencia_cierre_check" CHECK (
    ("estado" = 'activa' AND "controlada_at" IS NULL AND "controlada_por" IS NULL AND "cerrada_at" IS NULL AND "cerrada_por" IS NULL)
    OR ("estado" = 'controlada' AND "controlada_at" IS NOT NULL AND "controlada_por" IS NOT NULL AND "cerrada_at" IS NULL AND "cerrada_por" IS NULL
        AND "controlada_at" >= "activado_at")
    OR ("estado" = 'cerrada' AND "controlada_at" IS NOT NULL AND "controlada_por" IS NOT NULL AND "cerrada_at" IS NOT NULL AND "cerrada_por" IS NOT NULL
        AND "cerrada_at" >= "controlada_at"));

-- El Reporte Flash se emite con la emergencia sin cerrar.
CREATE TRIGGER "emergencia_reporte_flash_validar_trg" BEFORE INSERT ON "emergencia_reporte_flash" FOR EACH ROW EXECUTE FUNCTION "emergencia_hija_validar"();

-- Ciclo: activa → controlada → cerrada. Cerrar exige el Reporte Flash y el nivel declarado, y en nivel 2 o 3, la investigación (si la tabla existe).
CREATE OR REPLACE FUNCTION "emergencia_validar"() RETURNS trigger LANGUAGE plpgsql SET search_path = qhse, pg_catalog AS $$
DECLARE
  v_swa "estado_swa";
  v_investigacion BOOLEAN;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."estado" <> 'activa' THEN
      RAISE EXCEPTION 'Una emergencia nace activa' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."swa_id" IS NOT NULL THEN
      SELECT "estado" INTO v_swa FROM "swa" WHERE "id" = NEW."swa_id";
      IF v_swa = 'cerrado' THEN
        RAISE EXCEPTION 'Una SWA cerrada ya no escala a emergencia' USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF NEW."derrame_id" IS NOT NULL AND NOT "derrame_escala_a_emergencia"(NEW."derrame_id") THEN
      RAISE EXCEPTION 'Este derrame no escala a emergencia: solo el mayor o el que está en un cuerpo de agua' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."swa_id" IS DISTINCT FROM OLD."swa_id" OR NEW."derrame_id" IS DISTINCT FROM OLD."derrame_id" THEN
    RAISE EXCEPTION 'El origen de la emergencia no se cambia' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."estado" = 'cerrada' THEN
    RAISE EXCEPTION 'Una emergencia cerrada ya no se modifica' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."estado" = OLD."estado" THEN RETURN NEW; END IF;
  IF OLD."estado" = 'activa' AND NEW."estado" = 'controlada' THEN
    RETURN NEW;
  END IF;
  IF OLD."estado" = 'controlada' AND NEW."estado" = 'cerrada' THEN
    IF NOT EXISTS (SELECT 1 FROM "emergencia_reporte_flash" WHERE "emergencia_id" = NEW."id") THEN
      RAISE EXCEPTION 'Para cerrar la emergencia hay que emitir el Reporte Flash' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."nivel" IS NULL THEN
      RAISE EXCEPTION 'Para cerrar la emergencia hay que declarar su nivel' USING ERRCODE = 'check_violation';
    END IF;
    -- HSE-TRIAGE-002: el nivel 2 o 3 siempre origina una investigación. La tabla es de otra sesión: solo se comprueba si existe.
    IF NEW."nivel" >= 2 AND to_regclass('qhse.investigacion') IS NOT NULL THEN
      EXECUTE 'SELECT EXISTS (SELECT 1 FROM qhse.investigacion WHERE origen_emergencia_id = $1)' INTO v_investigacion USING NEW."id";
      IF NOT v_investigacion THEN
        RAISE EXCEPTION 'Una emergencia de nivel 2 o 3 no se cierra sin su investigación de incidentes (HSE-TRIAGE-002)' USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Cambio de estado no permitido: de % a %', OLD."estado", NEW."estado" USING ERRCODE = 'check_violation';
END
$$;

GRANT UPDATE ("controlada_at", "controlada_por", "cerrada_at", "cerrada_por") ON "emergencia" TO app_qhse;
REVOKE UPDATE, DELETE ON "emergencia_reporte_flash" FROM app_qhse;

COMMENT ON TABLE "emergencia_reporte_flash" IS 'Reporte Flash de la emergencia (HSE-TRIAGE-001): se emite una sola vez, completo, y es inmutable. Su plazo de 2 horas desde la activación se informa; no bloquea.';
COMMENT ON COLUMN "emergencia"."cerrada_at" IS 'Cerrar exige el Reporte Flash, el nivel declarado y, en nivel 2 o 3, la investigación (si existe qhse.investigacion). La FK investigacion.origen_emergencia_id → emergencia se agrega al integrar con la sesión de investigaciones.';
