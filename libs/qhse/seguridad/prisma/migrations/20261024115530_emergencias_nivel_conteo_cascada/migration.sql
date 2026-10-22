-- QHSE, tramo Q5: Emergencias, nivel, conteo de personal y cascada de notificación (HSE-TRIAGE-001). Base HSE declara el nivel 1 a 3 (puede subirlo
-- o bajarlo mientras la emergencia no esté cerrada; cada declaración queda en un historial inmutable). El conteo de personal (en locación,
-- evacuados; los faltantes se calculan) se repite las veces que haga falta, también con historial. La cascada de notificación son pasos con
-- origen, destino y plazo en minutos desde la activación; cada paso notificado queda registrado (quién y cuándo) y el plazo se informa.

-- Cascada: catálogo de pasos ------------------------------------------------------------------------------------------
-- «Base HSE» sustituye al «Coordinador HSE» de la demo (rol retirado, D4): lo que hacía el Coordinador lo hace el Gerente HSE.
CREATE TABLE "emergencia_paso_notificacion" (
    "id" UUID NOT NULL,
    "orden" INTEGER NOT NULL,
    "desde" TEXT NOT NULL,
    "hacia" TEXT NOT NULL,
    "plazo_minutos" INTEGER NOT NULL,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    CONSTRAINT "emergencia_paso_notificacion_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "emergencia_paso_notificacion_orden_key" UNIQUE ("orden"),
    CONSTRAINT "emergencia_paso_notificacion_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "emergencia_paso_notificacion_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "emergencia_paso_notificacion_texto_check" CHECK (length(btrim("desde")) > 0 AND length(btrim("hacia")) > 0),
    CONSTRAINT "emergencia_paso_notificacion_plazo_check" CHECK ("plazo_minutos" > 0)
);

CREATE TABLE "emergencia_notificacion" (
    "emergencia_id" UUID NOT NULL,
    "paso_id" UUID NOT NULL,
    "notificado_por" UUID NOT NULL,
    "notificado_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "emergencia_notificacion_pkey" PRIMARY KEY ("emergencia_id", "paso_id"),
    CONSTRAINT "emergencia_notificacion_emergencia_fkey" FOREIGN KEY ("emergencia_id") REFERENCES "emergencia" ("id") ON DELETE CASCADE,
    CONSTRAINT "emergencia_notificacion_paso_fkey" FOREIGN KEY ("paso_id") REFERENCES "emergencia_paso_notificacion" ("id"),
    CONSTRAINT "emergencia_notificacion_por_fkey" FOREIGN KEY ("notificado_por") REFERENCES identidad.usuario ("id")
);
CREATE INDEX "emergencia_notificacion_paso_idx" ON "emergencia_notificacion" ("paso_id");

-- Lo que se completa en la emergencia ----------------------------------------------------------------------------------
ALTER TABLE "emergencia"
  ADD COLUMN "nivel" SMALLINT,
  ADD COLUMN "nivel_declarado_por" UUID,
  ADD COLUMN "nivel_declarado_at" TIMESTAMPTZ(6),
  ADD COLUMN "total_en_locacion" INTEGER,
  ADD COLUMN "evacuados" INTEGER,
  ADD COLUMN "conteo_por" UUID,
  ADD COLUMN "conteo_at" TIMESTAMPTZ(6),
  ADD CONSTRAINT "emergencia_nivel_declarado_por_fkey" FOREIGN KEY ("nivel_declarado_por") REFERENCES identidad.usuario ("id"),
  ADD CONSTRAINT "emergencia_conteo_por_fkey" FOREIGN KEY ("conteo_por") REFERENCES identidad.usuario ("id"),
  -- el nivel es 1 (menor, controlable en sitio), 2 (moderada, apoyo externo) o 3 (mayor, amenaza vidas y operación), declarado completo
  ADD CONSTRAINT "emergencia_nivel_check" CHECK (
    ("nivel" IS NULL AND "nivel_declarado_por" IS NULL AND "nivel_declarado_at" IS NULL)
    OR ("nivel" BETWEEN 1 AND 3 AND "nivel_declarado_por" IS NOT NULL AND "nivel_declarado_at" IS NOT NULL)),
  -- el conteo se registra completo y los evacuados no pueden superar a los que estaban en la locación
  ADD CONSTRAINT "emergencia_conteo_check" CHECK (
    ("total_en_locacion" IS NULL AND "evacuados" IS NULL AND "conteo_por" IS NULL AND "conteo_at" IS NULL)
    OR ("total_en_locacion" >= 0 AND "evacuados" >= 0 AND "evacuados" <= "total_en_locacion" AND "conteo_por" IS NOT NULL AND "conteo_at" IS NOT NULL));

CREATE TABLE "emergencia_nivel_historial" (
    "id" UUID NOT NULL,
    "emergencia_id" UUID NOT NULL,
    "nivel" SMALLINT NOT NULL,
    "actor_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "emergencia_nivel_historial_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "emergencia_nivel_historial_emergencia_fkey" FOREIGN KEY ("emergencia_id") REFERENCES "emergencia" ("id") ON DELETE CASCADE,
    CONSTRAINT "emergencia_nivel_historial_actor_fkey" FOREIGN KEY ("actor_id") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "emergencia_nivel_historial_nivel_check" CHECK ("nivel" BETWEEN 1 AND 3)
);
CREATE INDEX "emergencia_nivel_historial_emergencia_idx" ON "emergencia_nivel_historial" ("emergencia_id", "created_at");

CREATE TABLE "emergencia_conteo_historial" (
    "id" UUID NOT NULL,
    "emergencia_id" UUID NOT NULL,
    "total_en_locacion" INTEGER NOT NULL,
    "evacuados" INTEGER NOT NULL,
    "actor_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "emergencia_conteo_historial_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "emergencia_conteo_historial_emergencia_fkey" FOREIGN KEY ("emergencia_id") REFERENCES "emergencia" ("id") ON DELETE CASCADE,
    CONSTRAINT "emergencia_conteo_historial_actor_fkey" FOREIGN KEY ("actor_id") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "emergencia_conteo_historial_check" CHECK ("total_en_locacion" >= 0 AND "evacuados" >= 0 AND "evacuados" <= "total_en_locacion")
);
CREATE INDEX "emergencia_conteo_historial_emergencia_idx" ON "emergencia_conteo_historial" ("emergencia_id", "created_at");

-- Reglas ------------------------------------------------------------------------------------------------------------
-- Una emergencia cerrada ya no cambia. El nivel, el conteo y las notificaciones se registran mientras no esté cerrada.
CREATE OR REPLACE FUNCTION "emergencia_validar"() RETURNS trigger LANGUAGE plpgsql SET search_path = qhse, pg_catalog AS $$
DECLARE
  v_swa "estado_swa";
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
  IF (OLD."estado" = 'activa' AND NEW."estado" = 'controlada') OR (OLD."estado" = 'controlada' AND NEW."estado" = 'cerrada') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Cambio de estado no permitido: de % a %', OLD."estado", NEW."estado" USING ERRCODE = 'check_violation';
END
$$;

CREATE FUNCTION "emergencia_hija_validar"() RETURNS trigger LANGUAGE plpgsql SET search_path = qhse, pg_catalog AS $$
DECLARE
  v_estado "estado_emergencia";
BEGIN
  SELECT "estado" INTO v_estado FROM "emergencia" WHERE "id" = NEW."emergencia_id";
  IF v_estado = 'cerrada' THEN
    RAISE EXCEPTION 'La emergencia está cerrada y ya no recibe registros' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "emergencia_notificacion_validar_trg" BEFORE INSERT ON "emergencia_notificacion" FOR EACH ROW EXECUTE FUNCTION "emergencia_hija_validar"();
CREATE TRIGGER "emergencia_nivel_historial_validar_trg" BEFORE INSERT ON "emergencia_nivel_historial" FOR EACH ROW EXECUTE FUNCTION "emergencia_hija_validar"();
CREATE TRIGGER "emergencia_conteo_historial_validar_trg" BEFORE INSERT ON "emergencia_conteo_historial" FOR EACH ROW EXECUTE FUNCTION "emergencia_hija_validar"();

-- Privilegios ---------------------------------------------------------------------------------------------------------------
GRANT UPDATE ("nivel", "nivel_declarado_por", "nivel_declarado_at", "total_en_locacion", "evacuados", "conteo_por", "conteo_at") ON "emergencia" TO app_qhse;
REVOKE UPDATE, DELETE ON "emergencia_notificacion" FROM app_qhse;
REVOKE UPDATE, DELETE ON "emergencia_nivel_historial" FROM app_qhse;
REVOKE UPDATE, DELETE ON "emergencia_conteo_historial" FROM app_qhse;
REVOKE DELETE ON "emergencia_paso_notificacion" FROM app_qhse;

COMMENT ON COLUMN "emergencia"."nivel" IS 'Nivel declarado por Base HSE: 1 menor (controlable en sitio), 2 moderada (apoyo externo), 3 mayor (amenaza vidas y operación). Vacío hasta declararlo; se puede cambiar mientras no esté cerrada (queda historial).';
COMMENT ON COLUMN "emergencia"."total_en_locacion" IS 'Conteo de personal: personas en la locación. Los evacuados no pueden superarlas; los faltantes se calculan (no se guardan).';
COMMENT ON TABLE "emergencia_paso_notificacion" IS 'Cascada de notificación (HSE-TRIAGE-001): cada paso con su origen, su destino y su plazo en minutos desde la activación. «Base HSE» sustituye al «Coordinador HSE» retirado (D4).';
COMMENT ON TABLE "emergencia_notificacion" IS 'Cada paso de la cascada ya notificado (quién y cuándo). El plazo se calcula contra la activación y se informa. Inmutable.';
COMMENT ON TABLE "emergencia_nivel_historial" IS 'Cada declaración de nivel (el vigente está en emergencia). Inmutable.';
COMMENT ON TABLE "emergencia_conteo_historial" IS 'Cada conteo de personal (el vigente está en emergencia). Inmutable.';
