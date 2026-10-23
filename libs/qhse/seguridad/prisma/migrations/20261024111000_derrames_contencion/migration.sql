-- QHSE, tramo Q4: Derrames, contención y volumen real. El checklist de contención de los primeros 5 minutos (HSE-AMBIENTAL-002) es un catálogo
-- de pasos; cada confirmación (quién y cuándo) es inmutable. El derrame solo pasa a contenido con todos los pasos confirmados. El plazo de
-- 5 minutos se calcula (activación → contención) y se informa: no bloquea. Después de contener, QHSE confirma el volumen REAL en barriles
-- (alimenta el KPI «volumen total derramado» de HSE-MASTER-001); cada confirmación queda en un historial inmutable.

-- Catálogo de pasos ---------------------------------------------------------------------------------------------------
CREATE TABLE "derrame_checklist_item" (
    "id" UUID NOT NULL,
    "codigo" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "orden" INTEGER NOT NULL,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    CONSTRAINT "derrame_checklist_item_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "derrame_checklist_item_codigo_key" UNIQUE ("codigo"),
    CONSTRAINT "derrame_checklist_item_orden_key" UNIQUE ("orden"),
    CONSTRAINT "derrame_checklist_item_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "derrame_checklist_item_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id")
);

CREATE TABLE "derrame_checklist_confirmacion" (
    "derrame_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "confirmado_por" UUID NOT NULL,
    "confirmado_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "derrame_checklist_confirmacion_pkey" PRIMARY KEY ("derrame_id", "item_id"),
    CONSTRAINT "derrame_checklist_confirmacion_derrame_fkey" FOREIGN KEY ("derrame_id") REFERENCES "derrame" ("id") ON DELETE CASCADE,
    CONSTRAINT "derrame_checklist_confirmacion_item_fkey" FOREIGN KEY ("item_id") REFERENCES "derrame_checklist_item" ("id"),
    CONSTRAINT "derrame_checklist_confirmacion_por_fkey" FOREIGN KEY ("confirmado_por") REFERENCES identidad.usuario ("id")
);
CREATE INDEX "derrame_checklist_confirmacion_item_idx" ON "derrame_checklist_confirmacion" ("item_id");

-- Lo que se completa en el derrame ----------------------------------------------------------------------------------------
ALTER TABLE "derrame"
  ADD COLUMN "contenido_at" TIMESTAMPTZ(6),
  ADD COLUMN "contenido_por" UUID,
  ADD COLUMN "volumen_real_barriles" NUMERIC(10,3),
  ADD COLUMN "volumen_confirmado_por" UUID,
  ADD COLUMN "volumen_confirmado_at" TIMESTAMPTZ(6),
  ADD CONSTRAINT "derrame_contenido_por_fkey" FOREIGN KEY ("contenido_por") REFERENCES identidad.usuario ("id"),
  ADD CONSTRAINT "derrame_volumen_confirmado_por_fkey" FOREIGN KEY ("volumen_confirmado_por") REFERENCES identidad.usuario ("id"),
  -- cada estado trae sus datos: activo no tiene contención; contenido y cerrado, sí
  ADD CONSTRAINT "derrame_contencion_check" CHECK (
    ("estado" = 'activo' AND "contenido_at" IS NULL AND "contenido_por" IS NULL)
    OR ("estado" <> 'activo' AND "contenido_at" IS NOT NULL AND "contenido_por" IS NOT NULL AND "contenido_at" >= "activado_at")),
  -- el volumen real se confirma después de contener, completo (valor, quién y cuándo) y sin negativos
  ADD CONSTRAINT "derrame_volumen_check" CHECK (
    ("volumen_real_barriles" IS NULL AND "volumen_confirmado_por" IS NULL AND "volumen_confirmado_at" IS NULL)
    OR ("volumen_real_barriles" >= 0 AND "volumen_confirmado_por" IS NOT NULL AND "volumen_confirmado_at" IS NOT NULL AND "estado" <> 'activo'));

-- Cada confirmación del volumen real queda registrada (el valor vigente está en el derrame).
CREATE TABLE "derrame_volumen_historial" (
    "id" UUID NOT NULL,
    "derrame_id" UUID NOT NULL,
    "volumen_barriles" NUMERIC(10,3) NOT NULL,
    "actor_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "derrame_volumen_historial_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "derrame_volumen_historial_derrame_fkey" FOREIGN KEY ("derrame_id") REFERENCES "derrame" ("id") ON DELETE CASCADE,
    CONSTRAINT "derrame_volumen_historial_actor_fkey" FOREIGN KEY ("actor_id") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "derrame_volumen_historial_volumen_check" CHECK ("volumen_barriles" >= 0)
);
CREATE INDEX "derrame_volumen_historial_derrame_idx" ON "derrame_volumen_historial" ("derrame_id", "created_at");

-- Ciclo: activo → contenido (exige todos los pasos del checklist) → cerrado. La notificación al MAE la exige la migración siguiente.
CREATE OR REPLACE FUNCTION "derrame_validar"() RETURNS trigger LANGUAGE plpgsql SET search_path = qhse, pg_catalog AS $$
DECLARE
  v_faltan INTEGER;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."estado" <> 'activo' THEN
      RAISE EXCEPTION 'Un derrame nace activo' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."estado" = OLD."estado" THEN RETURN NEW; END IF;
  IF OLD."estado" = 'activo' AND NEW."estado" = 'contenido' THEN
    SELECT count(*) INTO v_faltan FROM "derrame_checklist_item" i
     WHERE i."activo" AND NOT EXISTS (SELECT 1 FROM "derrame_checklist_confirmacion" c WHERE c."derrame_id" = NEW."id" AND c."item_id" = i."id");
    IF v_faltan > 0 THEN
      RAISE EXCEPTION 'Para marcar el derrame como contenido hay que confirmar todo el checklist de contención (faltan %)', v_faltan USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."estado" = 'contenido' AND NEW."estado" = 'cerrado' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Cambio de estado no permitido: de % a %', OLD."estado", NEW."estado" USING ERRCODE = 'check_violation';
END
$$;

-- Los pasos se confirman mientras el derrame está activo.
CREATE FUNCTION "derrame_confirmacion_validar"() RETURNS trigger LANGUAGE plpgsql SET search_path = qhse, pg_catalog AS $$
DECLARE
  v_estado "estado_derrame";
BEGIN
  SELECT "estado" INTO v_estado FROM "derrame" WHERE "id" = NEW."derrame_id";
  IF v_estado <> 'activo' THEN
    RAISE EXCEPTION 'Los pasos de contención se confirman con el derrame activo (está %)', v_estado USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "derrame_confirmacion_validar_trg" BEFORE INSERT ON "derrame_checklist_confirmacion" FOR EACH ROW EXECUTE FUNCTION "derrame_confirmacion_validar"();

-- El volumen real se confirma con el derrame contenido (y mientras no esté cerrado: después ya no se corrige).
CREATE FUNCTION "derrame_volumen_validar"() RETURNS trigger LANGUAGE plpgsql SET search_path = qhse, pg_catalog AS $$
DECLARE
  v_estado "estado_derrame";
BEGIN
  SELECT "estado" INTO v_estado FROM "derrame" WHERE "id" = NEW."derrame_id";
  IF v_estado <> 'contenido' THEN
    RAISE EXCEPTION 'El volumen real se confirma con el derrame contenido (está %)', v_estado USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "derrame_volumen_validar_trg" BEFORE INSERT ON "derrame_volumen_historial" FOR EACH ROW EXECUTE FUNCTION "derrame_volumen_validar"();

-- Privilegios ---------------------------------------------------------------------------------------------------------------
GRANT UPDATE ("contenido_at", "contenido_por", "volumen_real_barriles", "volumen_confirmado_por", "volumen_confirmado_at") ON "derrame" TO app_qhse;
REVOKE UPDATE, DELETE ON "derrame_checklist_confirmacion" FROM app_qhse;
REVOKE UPDATE, DELETE ON "derrame_volumen_historial" FROM app_qhse;

COMMENT ON TABLE "derrame_checklist_item" IS 'Pasos de la contención en los primeros 5 minutos (HSE-AMBIENTAL-002). Para marcar el derrame como contenido hay que confirmar todos los activos.';
COMMENT ON TABLE "derrame_checklist_confirmacion" IS 'Quién confirmó cada paso y cuándo. Inmutable.';
COMMENT ON COLUMN "derrame"."contenido_at" IS 'Cuándo se contuvo. El plazo de 5 minutos desde activado_at se calcula y se informa; no bloquea.';
COMMENT ON COLUMN "derrame"."volumen_real_barriles" IS 'Volumen real estimado tras la contención, confirmado por QHSE (alimenta el KPI de HSE-MASTER-001). La banda reportada al activar es otra cosa: banda_id.';
COMMENT ON TABLE "derrame_volumen_historial" IS 'Cada confirmación del volumen real (el vigente está en derrame). Inmutable.';
