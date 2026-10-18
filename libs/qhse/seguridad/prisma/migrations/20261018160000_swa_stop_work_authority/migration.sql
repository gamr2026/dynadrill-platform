-- QHSE, tramo Q2: Stop Work Authority (SWA, HSE-SEGUIMIENTO-003). Cualquier trabajador la activa; la gestionan el Técnico y el Gerente HSE.
-- Ciclo: activo (trabajo detenido) → evaluado (riesgo real o falsa alarma; exige haber notificado a todos los roles de la cadena) →
-- cerrado (reanudado; exige todo el checklist de reinicio). Dynadrill (18/10/2026): una SWA activa BLOQUEA el ticket (D10); por eso se
-- publica con el `ticketId`. Los catálogos (tipos de peligro, roles de la cadena, criterios de reinicio) son tablas, no texto.

CREATE TYPE "estado_swa" AS ENUM ('activo', 'evaluado', 'cerrado');

-- Catálogos ------------------------------------------------------------------------------------------------------
CREATE TABLE "swa_tipo_peligro" (
    "id" UUID NOT NULL,
    "codigo" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "orden" INTEGER NOT NULL,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    CONSTRAINT "swa_tipo_peligro_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "swa_tipo_peligro_codigo_key" UNIQUE ("codigo"),
    CONSTRAINT "swa_tipo_peligro_orden_key" UNIQUE ("orden"),
    CONSTRAINT "swa_tipo_peligro_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "swa_tipo_peligro_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id")
);

-- Roles que deben enterarse de una SWA (cadena de notificación): Supervisor, Técnico HSE y Gerente HSE.
CREATE TABLE "swa_rol_cadena" (
    "id" UUID NOT NULL,
    "rol_id" UUID NOT NULL,
    "orden" INTEGER NOT NULL,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    CONSTRAINT "swa_rol_cadena_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "swa_rol_cadena_rol_key" UNIQUE ("rol_id"),
    CONSTRAINT "swa_rol_cadena_orden_key" UNIQUE ("orden"),
    CONSTRAINT "swa_rol_cadena_rol_fkey" FOREIGN KEY ("rol_id") REFERENCES identidad.rol ("id"),
    CONSTRAINT "swa_rol_cadena_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "swa_rol_cadena_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id")
);

CREATE TABLE "swa_criterio_reinicio" (
    "id" UUID NOT NULL,
    "codigo" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "orden" INTEGER NOT NULL,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    CONSTRAINT "swa_criterio_reinicio_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "swa_criterio_reinicio_codigo_key" UNIQUE ("codigo"),
    CONSTRAINT "swa_criterio_reinicio_orden_key" UNIQUE ("orden"),
    CONSTRAINT "swa_criterio_reinicio_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "swa_criterio_reinicio_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id")
);

-- La SWA ----------------------------------------------------------------------------------------------------------
CREATE TABLE "swa" (
    "id" UUID NOT NULL,
    "numero" INTEGER GENERATED ALWAYS AS IDENTITY,
    "ticket_id" UUID,
    "tipo_peligro_id" UUID NOT NULL,
    "descripcion" TEXT NOT NULL,
    "ubicacion" TEXT,
    "activado_por" UUID NOT NULL,
    "activado_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "estado" "estado_swa" NOT NULL DEFAULT 'activo',
    "riesgo_real" BOOLEAN,
    "evaluacion_nota" TEXT,
    "evaluado_por" UUID,
    "evaluado_at" TIMESTAMPTZ(6),
    "reanudado_por" UUID,
    "reanudado_at" TIMESTAMPTZ(6),
    "heroe_seguridad" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    CONSTRAINT "swa_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "swa_ticket_fkey" FOREIGN KEY ("ticket_id") REFERENCES "ticket_ref" ("ticket_id"),
    CONSTRAINT "swa_tipo_peligro_fkey" FOREIGN KEY ("tipo_peligro_id") REFERENCES "swa_tipo_peligro" ("id"),
    CONSTRAINT "swa_activado_por_fkey" FOREIGN KEY ("activado_por") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "swa_evaluado_por_fkey" FOREIGN KEY ("evaluado_por") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "swa_reanudado_por_fkey" FOREIGN KEY ("reanudado_por") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "swa_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "swa_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "swa_descripcion_check" CHECK (length(btrim("descripcion")) > 0),
    -- cada estado trae sus datos completos y nada de los siguientes
    CONSTRAINT "swa_estado_check" CHECK (
      ("estado" = 'activo' AND "riesgo_real" IS NULL AND "evaluado_por" IS NULL AND "evaluado_at" IS NULL AND "reanudado_por" IS NULL AND "reanudado_at" IS NULL)
      OR ("estado" = 'evaluado' AND "riesgo_real" IS NOT NULL AND "evaluado_por" IS NOT NULL AND "evaluado_at" IS NOT NULL AND "reanudado_por" IS NULL AND "reanudado_at" IS NULL)
      OR ("estado" = 'cerrado' AND "riesgo_real" IS NOT NULL AND "evaluado_por" IS NOT NULL AND "evaluado_at" IS NOT NULL AND "reanudado_por" IS NOT NULL AND "reanudado_at" IS NOT NULL)),
    -- el reconocimiento «Héroe de Seguridad» se da al cerrar
    CONSTRAINT "swa_heroe_check" CHECK (NOT "heroe_seguridad" OR "estado" = 'cerrado')
);
CREATE INDEX "swa_ticket_idx" ON "swa" ("ticket_id") WHERE "ticket_id" IS NOT NULL;
CREATE INDEX "swa_estado_idx" ON "swa" ("estado");
CREATE INDEX "swa_tipo_peligro_idx" ON "swa" ("tipo_peligro_id");

-- Notificaciones a la cadena (una por rol y SWA) y confirmaciones del checklist de reinicio: solo se agregan.
CREATE TABLE "swa_notificacion" (
    "id" UUID NOT NULL,
    "swa_id" UUID NOT NULL,
    "rol_cadena_id" UUID NOT NULL,
    "notificado_por" UUID NOT NULL,
    "notificado_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "swa_notificacion_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "swa_notificacion_unica_key" UNIQUE ("swa_id", "rol_cadena_id"),
    CONSTRAINT "swa_notificacion_swa_fkey" FOREIGN KEY ("swa_id") REFERENCES "swa" ("id") ON DELETE CASCADE,
    CONSTRAINT "swa_notificacion_rol_fkey" FOREIGN KEY ("rol_cadena_id") REFERENCES "swa_rol_cadena" ("id"),
    CONSTRAINT "swa_notificacion_por_fkey" FOREIGN KEY ("notificado_por") REFERENCES identidad.usuario ("id")
);

CREATE TABLE "swa_reinicio" (
    "id" UUID NOT NULL,
    "swa_id" UUID NOT NULL,
    "criterio_id" UUID NOT NULL,
    "confirmado_por" UUID NOT NULL,
    "confirmado_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "swa_reinicio_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "swa_reinicio_unica_key" UNIQUE ("swa_id", "criterio_id"),
    CONSTRAINT "swa_reinicio_swa_fkey" FOREIGN KEY ("swa_id") REFERENCES "swa" ("id") ON DELETE CASCADE,
    CONSTRAINT "swa_reinicio_criterio_fkey" FOREIGN KEY ("criterio_id") REFERENCES "swa_criterio_reinicio" ("id"),
    CONSTRAINT "swa_reinicio_por_fkey" FOREIGN KEY ("confirmado_por") REFERENCES identidad.usuario ("id")
);

CREATE TABLE "swa_historial" (
    "id" UUID NOT NULL,
    "swa_id" UUID NOT NULL,
    "estado_anterior" "estado_swa",
    "estado_nuevo" "estado_swa" NOT NULL,
    "actor_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "swa_historial_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "swa_historial_swa_fkey" FOREIGN KEY ("swa_id") REFERENCES "swa" ("id") ON DELETE CASCADE,
    CONSTRAINT "swa_historial_actor_fkey" FOREIGN KEY ("actor_id") REFERENCES identidad.usuario ("id")
);
CREATE INDEX "swa_historial_swa_idx" ON "swa_historial" ("swa_id", "created_at");

-- Reglas del ciclo ---------------------------------------------------------------------------------------------------
CREATE FUNCTION "swa_validar"() RETURNS trigger LANGUAGE plpgsql SET search_path = qhse, pg_catalog AS $$
DECLARE
  v_pend INTEGER;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."estado" <> 'activo' THEN
      RAISE EXCEPTION 'Una SWA nace activa' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."estado" = OLD."estado" THEN RETURN NEW; END IF;

  IF OLD."estado" = 'activo' AND NEW."estado" = 'evaluado' THEN
    SELECT count(*) INTO v_pend FROM "swa_rol_cadena" c
     WHERE c."activo" AND NOT EXISTS (SELECT 1 FROM "swa_notificacion" n WHERE n."swa_id" = NEW."id" AND n."rol_cadena_id" = c."id");
    IF v_pend > 0 THEN
      RAISE EXCEPTION 'La evaluación queda bloqueada hasta notificar a todos los roles de la cadena (faltan %)', v_pend USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."estado" = 'evaluado' AND NEW."estado" = 'cerrado' THEN
    SELECT count(*) INTO v_pend FROM "swa_criterio_reinicio" c
     WHERE c."activo" AND NOT EXISTS (SELECT 1 FROM "swa_reinicio" r WHERE r."swa_id" = NEW."id" AND r."criterio_id" = c."id");
    IF v_pend > 0 THEN
      RAISE EXCEPTION 'Para reanudar hay que confirmar todo el checklist de reinicio (faltan %)', v_pend USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Cambio de estado no permitido: de % a %', OLD."estado", NEW."estado" USING ERRCODE = 'check_violation';
END
$$;
CREATE TRIGGER "swa_validar_trg" BEFORE INSERT OR UPDATE ON "swa" FOR EACH ROW EXECUTE FUNCTION "swa_validar"();

-- Las notificaciones se registran mientras la SWA está activa y el checklist de reinicio, una vez evaluada.
CREATE FUNCTION "swa_notificacion_validar"() RETURNS trigger LANGUAGE plpgsql SET search_path = qhse, pg_catalog AS $$
DECLARE v_estado "estado_swa";
BEGIN
  SELECT "estado" INTO v_estado FROM "swa" WHERE "id" = NEW."swa_id";
  IF v_estado <> 'activo' THEN
    RAISE EXCEPTION 'Las notificaciones se registran mientras la SWA está activa (está %)', v_estado USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "swa_notificacion_validar_trg" BEFORE INSERT ON "swa_notificacion" FOR EACH ROW EXECUTE FUNCTION "swa_notificacion_validar"();

CREATE FUNCTION "swa_reinicio_validar"() RETURNS trigger LANGUAGE plpgsql SET search_path = qhse, pg_catalog AS $$
DECLARE v_estado "estado_swa";
BEGIN
  SELECT "estado" INTO v_estado FROM "swa" WHERE "id" = NEW."swa_id";
  IF v_estado <> 'evaluado' THEN
    RAISE EXCEPTION 'El checklist de reinicio se confirma con la SWA evaluada (está %)', v_estado USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "swa_reinicio_validar_trg" BEFORE INSERT ON "swa_reinicio" FOR EACH ROW EXECUTE FUNCTION "swa_reinicio_validar"();

-- Privilegios: lo activado no se reescribe (solo avanzan el estado y sus datos); lo registrado no se edita ni se borra -------
REVOKE UPDATE ON "swa" FROM app_qhse;
GRANT UPDATE ("estado", "riesgo_real", "evaluacion_nota", "evaluado_por", "evaluado_at", "reanudado_por", "reanudado_at", "heroe_seguridad",
              "updated_at", "updated_by") ON "swa" TO app_qhse;
REVOKE DELETE ON "swa" FROM app_qhse;
REVOKE UPDATE, DELETE ON "swa_notificacion" FROM app_qhse;
REVOKE UPDATE, DELETE ON "swa_reinicio" FROM app_qhse;
REVOKE UPDATE, DELETE ON "swa_historial" FROM app_qhse;

COMMENT ON TABLE "swa" IS 'Stop Work Authority: cualquier trabajador detiene un trabajo. Una SWA sin cerrar bloquea el ticket (D10, confirmado por Dynadrill el 18/10/2026). Consecutivo SWA-000001.';
COMMENT ON COLUMN "swa"."ticket_id" IS 'Ticket detenido (referencia local ticket_ref); nulo si la SWA no es de un servicio.';
COMMENT ON COLUMN "swa"."ubicacion" IS 'Descripción libre del sitio donde se detuvo el trabajo (no hay un catálogo de ubicaciones de locación).';
COMMENT ON COLUMN "swa"."heroe_seguridad" IS 'Reconocimiento «Héroe de Seguridad»: lo otorga el equipo HSE al cerrar.';
COMMENT ON TABLE "swa_rol_cadena" IS 'Roles que deben enterarse de una SWA (Supervisor, Técnico HSE, Gerente HSE; el Coordinador HSE se retiró, D4). La evaluación exige haberlos notificado a todos.';
COMMENT ON TABLE "swa_notificacion" IS 'Quién notificó a cada rol de la cadena y cuándo. Inmutable.';
COMMENT ON TABLE "swa_reinicio" IS 'Confirmaciones del checklist de reinicio. Inmutable.';
COMMENT ON TABLE "swa_historial" IS 'Rastro de cada cambio de estado. Solo se agrega.';
