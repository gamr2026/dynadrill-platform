-- QHSE, tramo Q5: Emergencias, heridos, triage médico por color y MEDEVAC (HSE-TRIAGE-001). Cada herido lleva su triage (rojo, amarillo, verde o negro), los signos
-- vitales que se le toman (cada toma es un registro nuevo, inmutable) y, si cumple los criterios MEDEVAC (lesión que amenaza la vida, atención
-- hospitalaria en menos de 2 horas, no tratable en campo), su evacuación: activar → medio de transporte, hospital y ETA → hospital notificado →
-- transferido. El orden lo exige la base. Los hospitales son un catálogo que el equipo HSE amplía; el nivel de consciencia usa una escala de
-- cuatro valores (decisión del 24/10/2026).

CREATE TYPE "triage_color" AS ENUM ('rojo', 'amarillo', 'verde', 'negro');
CREATE TYPE "medio_transporte_medevac" AS ENUM ('ambulancia', 'lancha', 'helicoptero');
CREATE TYPE "nivel_consciencia" AS ENUM ('alerta', 'voz', 'dolor', 'inconsciente');

-- Hospitales (catálogo editable por QHSE) -----------------------------------------------------------------------------
CREATE TABLE "emergencia_hospital" (
    "id" UUID NOT NULL,
    "nombre" TEXT NOT NULL,
    "ciudad" TEXT NOT NULL,
    "telefono" TEXT,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    CONSTRAINT "emergencia_hospital_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "emergencia_hospital_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "emergencia_hospital_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "emergencia_hospital_texto_check" CHECK (length(btrim("nombre")) > 0 AND length(btrim("ciudad")) > 0),
    CONSTRAINT "emergencia_hospital_telefono_check" CHECK ("telefono" IS NULL OR length(btrim("telefono")) > 0)
);
-- sin duplicados por nombre y ciudad, ignorando mayúsculas
CREATE UNIQUE INDEX "emergencia_hospital_nombre_key" ON "emergencia_hospital" (lower(btrim("nombre")), lower(btrim("ciudad")));

-- El herido ------------------------------------------------------------------------------------------------------------
CREATE TABLE "herido" (
    "id" UUID NOT NULL,
    "emergencia_id" UUID NOT NULL,
    "nombre_completo" TEXT NOT NULL,
    "cedula" TEXT,
    "triage" "triage_color" NOT NULL,
    "mecanismo_lesion" TEXT NOT NULL,
    "lesiones" TEXT,
    "tratamiento_campo" TEXT,
    "medevac_at" TIMESTAMPTZ(6),
    "medevac_por" UUID,
    "medio_transporte" "medio_transporte_medevac",
    "hospital_id" UUID,
    "eta_minutos" INTEGER,
    "hospital_notificado_at" TIMESTAMPTZ(6),
    "hospital_notificado_por" UUID,
    "transferido_at" TIMESTAMPTZ(6),
    "transferido_por" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    CONSTRAINT "herido_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "herido_emergencia_fkey" FOREIGN KEY ("emergencia_id") REFERENCES "emergencia" ("id") ON DELETE CASCADE,
    CONSTRAINT "herido_hospital_fkey" FOREIGN KEY ("hospital_id") REFERENCES "emergencia_hospital" ("id"),
    CONSTRAINT "herido_medevac_por_fkey" FOREIGN KEY ("medevac_por") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "herido_hospital_notificado_por_fkey" FOREIGN KEY ("hospital_notificado_por") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "herido_transferido_por_fkey" FOREIGN KEY ("transferido_por") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "herido_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "herido_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "herido_texto_check" CHECK (length(btrim("nombre_completo")) > 0 AND length(btrim("mecanismo_lesion")) > 0),
    CONSTRAINT "herido_cedula_check" CHECK ("cedula" IS NULL OR length(btrim("cedula")) > 0),
    -- cada hito del MEDEVAC trae quién y cuándo
    CONSTRAINT "herido_medevac_check" CHECK (("medevac_at" IS NULL) = ("medevac_por" IS NULL)),
    CONSTRAINT "herido_hospital_notificado_check" CHECK (("hospital_notificado_at" IS NULL) = ("hospital_notificado_por" IS NULL)),
    CONSTRAINT "herido_transferido_check" CHECK (("transferido_at" IS NULL) = ("transferido_por" IS NULL)),
    -- el medio, el hospital y el ETA solo existen con el MEDEVAC activado; un fallecido (negro) no se evacúa
    CONSTRAINT "herido_medevac_datos_check" CHECK (
      "medevac_at" IS NOT NULL OR ("medio_transporte" IS NULL AND "hospital_id" IS NULL AND "eta_minutos" IS NULL)),
    CONSTRAINT "herido_medevac_negro_check" CHECK ("medevac_at" IS NULL OR "triage" <> 'negro'),
    CONSTRAINT "herido_eta_check" CHECK ("eta_minutos" IS NULL OR "eta_minutos" > 0),
    -- no se notifica al hospital sin medio de transporte y hospital; no se transfiere sin haber notificado al hospital
    CONSTRAINT "herido_notificado_orden_check" CHECK (
      "hospital_notificado_at" IS NULL OR ("medevac_at" IS NOT NULL AND "medio_transporte" IS NOT NULL AND "hospital_id" IS NOT NULL)),
    CONSTRAINT "herido_transferido_orden_check" CHECK ("transferido_at" IS NULL OR "hospital_notificado_at" IS NOT NULL),
    CONSTRAINT "herido_orden_fechas_check" CHECK (
      ("hospital_notificado_at" IS NULL OR "hospital_notificado_at" >= "medevac_at")
      AND ("transferido_at" IS NULL OR "transferido_at" >= "hospital_notificado_at"))
);
CREATE INDEX "herido_emergencia_idx" ON "herido" ("emergencia_id");
CREATE INDEX "herido_hospital_idx" ON "herido" ("hospital_id") WHERE "hospital_id" IS NOT NULL;

-- Cada cambio de triage queda registrado (el vigente está en `herido`).
CREATE TABLE "herido_triage_historial" (
    "id" UUID NOT NULL,
    "herido_id" UUID NOT NULL,
    "triage" "triage_color" NOT NULL,
    "actor_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "herido_triage_historial_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "herido_triage_historial_herido_fkey" FOREIGN KEY ("herido_id") REFERENCES "herido" ("id") ON DELETE CASCADE,
    CONSTRAINT "herido_triage_historial_actor_fkey" FOREIGN KEY ("actor_id") REFERENCES identidad.usuario ("id")
);
CREATE INDEX "herido_triage_historial_herido_idx" ON "herido_triage_historial" ("herido_id", "created_at");

-- Signos vitales: cada toma es un registro nuevo, nunca se edita. Presión arterial en dos columnas (sistólica y diastólica).
CREATE TABLE "herido_signos_vitales" (
    "id" UUID NOT NULL,
    "herido_id" UUID NOT NULL,
    "registrado_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "registrado_por" UUID NOT NULL,
    "pulso" INTEGER,
    "presion_sistolica" INTEGER,
    "presion_diastolica" INTEGER,
    "respiracion" INTEGER,
    "consciencia" "nivel_consciencia",
    CONSTRAINT "herido_signos_vitales_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "herido_signos_vitales_herido_fkey" FOREIGN KEY ("herido_id") REFERENCES "herido" ("id") ON DELETE CASCADE,
    CONSTRAINT "herido_signos_vitales_por_fkey" FOREIGN KEY ("registrado_por") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "herido_signos_vitales_alguno_check" CHECK (
      "pulso" IS NOT NULL OR "presion_sistolica" IS NOT NULL OR "respiracion" IS NOT NULL OR "consciencia" IS NOT NULL),
    CONSTRAINT "herido_signos_vitales_pulso_check" CHECK ("pulso" IS NULL OR "pulso" BETWEEN 0 AND 300),
    CONSTRAINT "herido_signos_vitales_respiracion_check" CHECK ("respiracion" IS NULL OR "respiracion" BETWEEN 0 AND 100),
    -- la presión se toma completa y la sistólica no es menor que la diastólica
    CONSTRAINT "herido_signos_vitales_presion_check" CHECK (
      ("presion_sistolica" IS NULL AND "presion_diastolica" IS NULL)
      OR ("presion_sistolica" BETWEEN 0 AND 300 AND "presion_diastolica" BETWEEN 0 AND 300 AND "presion_sistolica" >= "presion_diastolica"))
);
CREATE INDEX "herido_signos_vitales_herido_idx" ON "herido_signos_vitales" ("herido_id", "registrado_at");

-- Reglas ------------------------------------------------------------------------------------------------------------
-- Los heridos se registran y se actualizan mientras la emergencia no esté cerrada (reutiliza `emergencia_hija_validar`, que lee emergencia_id).
CREATE TRIGGER "herido_validar_trg" BEFORE INSERT OR UPDATE ON "herido" FOR EACH ROW EXECUTE FUNCTION "emergencia_hija_validar"();

-- Cada herido pertenece a una emergencia que se queda con su triage anterior en el historial al cambiarlo; no se cambia de emergencia.
CREATE FUNCTION "herido_inmutable_validar"() RETURNS trigger LANGUAGE plpgsql SET search_path = qhse, pg_catalog AS $$
BEGIN
  IF NEW."emergencia_id" IS DISTINCT FROM OLD."emergencia_id" THEN
    RAISE EXCEPTION 'Un herido no se pasa a otra emergencia' USING ERRCODE = 'check_violation';
  END IF;
  -- los hitos del MEDEVAC no se deshacen: una vez registrados, no cambian ni se borran
  IF (OLD."medevac_at" IS NOT NULL AND NEW."medevac_at" IS DISTINCT FROM OLD."medevac_at")
     OR (OLD."hospital_notificado_at" IS NOT NULL AND NEW."hospital_notificado_at" IS DISTINCT FROM OLD."hospital_notificado_at")
     OR (OLD."transferido_at" IS NOT NULL AND NEW."transferido_at" IS DISTINCT FROM OLD."transferido_at") THEN
    RAISE EXCEPTION 'Un hito del MEDEVAC ya registrado no se cambia' USING ERRCODE = 'check_violation';
  END IF;
  -- tras transferirlo, el destino ya no cambia
  IF OLD."transferido_at" IS NOT NULL AND (NEW."hospital_id" IS DISTINCT FROM OLD."hospital_id" OR NEW."medio_transporte" IS DISTINCT FROM OLD."medio_transporte"
      OR NEW."eta_minutos" IS DISTINCT FROM OLD."eta_minutos") THEN
    RAISE EXCEPTION 'El herido ya fue transferido: su destino no se cambia' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "herido_inmutable_validar_trg" BEFORE UPDATE ON "herido" FOR EACH ROW EXECUTE FUNCTION "herido_inmutable_validar"();

CREATE FUNCTION "herido_hijo_validar"() RETURNS trigger LANGUAGE plpgsql SET search_path = qhse, pg_catalog AS $$
DECLARE
  v_estado "estado_emergencia";
BEGIN
  SELECT e."estado" INTO v_estado FROM "herido" h JOIN "emergencia" e ON e."id" = h."emergencia_id" WHERE h."id" = NEW."herido_id";
  IF v_estado = 'cerrada' THEN
    RAISE EXCEPTION 'La emergencia está cerrada y ya no recibe registros' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "herido_signos_vitales_validar_trg" BEFORE INSERT ON "herido_signos_vitales" FOR EACH ROW EXECUTE FUNCTION "herido_hijo_validar"();
CREATE TRIGGER "herido_triage_historial_validar_trg" BEFORE INSERT ON "herido_triage_historial" FOR EACH ROW EXECUTE FUNCTION "herido_hijo_validar"();

-- Privilegios: del herido solo se completa lo clínico y los hitos del MEDEVAC; lo que se registró no se borra ---------
REVOKE UPDATE ON "herido" FROM app_qhse;
GRANT UPDATE ("triage", "lesiones", "tratamiento_campo", "medevac_at", "medevac_por", "medio_transporte", "hospital_id", "eta_minutos",
              "hospital_notificado_at", "hospital_notificado_por", "transferido_at", "transferido_por", "updated_at", "updated_by") ON "herido" TO app_qhse;
REVOKE DELETE ON "herido" FROM app_qhse;
REVOKE UPDATE, DELETE ON "herido_triage_historial" FROM app_qhse;
REVOKE UPDATE, DELETE ON "herido_signos_vitales" FROM app_qhse;
REVOKE DELETE ON "emergencia_hospital" FROM app_qhse;

COMMENT ON TABLE "herido" IS 'Herido de una emergencia (HSE-TRIAGE-001): triage por color, lesiones, tratamiento en campo y evacuación MEDEVAC. Criterios MEDEVAC: lesión que amenaza la vida, atención hospitalaria en menos de 2 horas, no tratable en campo.';
COMMENT ON COLUMN "herido"."cedula" IS 'Cédula del herido, opcional: puede ser personal de contratistas o terceros sin cuenta en el portal. Dato personal: solo lo ve el equipo HSE.';
COMMENT ON COLUMN "herido"."medevac_at" IS 'Cuándo se activó el MEDEVAC. Orden exigido por la base: activar → medio de transporte y hospital → hospital notificado → transferido. Un fallecido (triage negro) no se evacúa.';
COMMENT ON TABLE "emergencia_hospital" IS 'Hospitales a los que se evacúa (catálogo editable por QHSE; sin duplicados por nombre y ciudad).';
COMMENT ON TABLE "herido_signos_vitales" IS 'Cada toma de signos vitales de un herido (pulso, presión sistólica y diastólica, respiración, consciencia). Solo se agrega.';
COMMENT ON TABLE "herido_triage_historial" IS 'Cada triage asignado a un herido (el vigente está en herido). Solo se agrega.';
