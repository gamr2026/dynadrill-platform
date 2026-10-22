-- QHSE, tramo Q5: Emergencias / MEDEVAC (HSE-TRIAGE-001). Esta migración trae el registro de la emergencia: la activa cualquier trabajador (directa,
-- o por escalada desde una SWA o desde un derrame mayor o en cuerpo de agua) y el cronómetro del evento, una línea por acción con la hora
-- del servidor. El nivel, el conteo de personal, la cascada de notificación, los heridos y el MEDEVAC, el Reporte Flash y el cierre llegan en las
-- migraciones siguientes.

CREATE TYPE "estado_emergencia" AS ENUM ('activa', 'controlada', 'cerrada');

-- Catálogo -------------------------------------------------------------------------------------------------------
CREATE TABLE "emergencia_tipo" (
    "id" UUID NOT NULL,
    "codigo" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "orden" INTEGER NOT NULL,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    CONSTRAINT "emergencia_tipo_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "emergencia_tipo_codigo_key" UNIQUE ("codigo"),
    CONSTRAINT "emergencia_tipo_orden_key" UNIQUE ("orden"),
    CONSTRAINT "emergencia_tipo_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "emergencia_tipo_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id")
);

-- ¿Este derrame escala a emergencia mayor? La ubicación, la banda reportada o la banda del volumen real lo exigen (HSE-MASTER-001): la misma
-- regla que aplica el servicio y que `derrame_requiere_mae` aplica al MAE.
CREATE FUNCTION "derrame_escala_a_emergencia"(p_derrame UUID) RETURNS BOOLEAN LANGUAGE sql STABLE SET search_path = qhse, pg_catalog AS $$
  SELECT COALESCE(
    (SELECT u."escala_a_emergencia" OR b."escala_a_emergencia"
            OR COALESCE((SELECT r."escala_a_emergencia" FROM "derrame_banda_volumen" r
                          WHERE r."activo" AND d."volumen_real_barriles" IS NOT NULL
                            AND d."volumen_real_barriles" >= r."desde_barriles"
                            AND (r."hasta_barriles" IS NULL OR d."volumen_real_barriles" < r."hasta_barriles")), false)
       FROM "derrame" d
       JOIN "derrame_ubicacion" u ON u."id" = d."ubicacion_id"
       JOIN "derrame_banda_volumen" b ON b."id" = d."banda_id"
      WHERE d."id" = p_derrame), false)
$$;

-- La emergencia ------------------------------------------------------------------------------------------------------
CREATE TABLE "emergencia" (
    "id" UUID NOT NULL,
    "numero" INTEGER GENERATED ALWAYS AS IDENTITY,
    "estado" "estado_emergencia" NOT NULL DEFAULT 'activa',
    "tipo_id" UUID NOT NULL,
    "descripcion" TEXT NOT NULL,
    "ubicacion" TEXT,
    "ticket_id" UUID,
    "swa_id" UUID,
    "derrame_id" UUID,
    "activado_por" UUID NOT NULL,
    "activado_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    CONSTRAINT "emergencia_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "emergencia_numero_key" UNIQUE ("numero"),
    CONSTRAINT "emergencia_tipo_fkey" FOREIGN KEY ("tipo_id") REFERENCES "emergencia_tipo" ("id"),
    CONSTRAINT "emergencia_ticket_fkey" FOREIGN KEY ("ticket_id") REFERENCES "ticket_ref" ("ticket_id"),
    CONSTRAINT "emergencia_swa_fkey" FOREIGN KEY ("swa_id") REFERENCES "swa" ("id"),
    CONSTRAINT "emergencia_derrame_fkey" FOREIGN KEY ("derrame_id") REFERENCES "derrame" ("id"),
    CONSTRAINT "emergencia_activado_por_fkey" FOREIGN KEY ("activado_por") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "emergencia_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "emergencia_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "emergencia_descripcion_check" CHECK (length(btrim("descripcion")) > 0),
    -- el origen es una SWA o un derrame, no los dos
    CONSTRAINT "emergencia_origen_check" CHECK ("swa_id" IS NULL OR "derrame_id" IS NULL)
);
CREATE INDEX "emergencia_estado_idx" ON "emergencia" ("estado");
CREATE INDEX "emergencia_ticket_idx" ON "emergencia" ("ticket_id") WHERE "ticket_id" IS NOT NULL;
CREATE INDEX "emergencia_tipo_idx" ON "emergencia" ("tipo_id");
-- una SWA o un derrame escala una sola vez
CREATE UNIQUE INDEX "emergencia_swa_key" ON "emergencia" ("swa_id") WHERE "swa_id" IS NOT NULL;
CREATE UNIQUE INDEX "emergencia_derrame_key" ON "emergencia" ("derrame_id") WHERE "derrame_id" IS NOT NULL;

-- Cronómetro del evento: una línea por acción, con la hora del servidor. Solo se agrega.
CREATE TABLE "emergencia_linea" (
    "id" UUID NOT NULL,
    "emergencia_id" UUID NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "texto" TEXT NOT NULL,
    "automatica" BOOLEAN NOT NULL DEFAULT false,
    "actor_id" UUID NOT NULL,
    CONSTRAINT "emergencia_linea_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "emergencia_linea_emergencia_fkey" FOREIGN KEY ("emergencia_id") REFERENCES "emergencia" ("id") ON DELETE CASCADE,
    CONSTRAINT "emergencia_linea_actor_fkey" FOREIGN KEY ("actor_id") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "emergencia_linea_texto_check" CHECK (length(btrim("texto")) > 0)
);
CREATE INDEX "emergencia_linea_emergencia_idx" ON "emergencia_linea" ("emergencia_id", "at");

CREATE TABLE "emergencia_historial" (
    "id" UUID NOT NULL,
    "emergencia_id" UUID NOT NULL,
    "estado_anterior" "estado_emergencia",
    "estado_nuevo" "estado_emergencia" NOT NULL,
    "actor_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "emergencia_historial_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "emergencia_historial_emergencia_fkey" FOREIGN KEY ("emergencia_id") REFERENCES "emergencia" ("id") ON DELETE CASCADE,
    CONSTRAINT "emergencia_historial_actor_fkey" FOREIGN KEY ("actor_id") REFERENCES identidad.usuario ("id")
);
CREATE INDEX "emergencia_historial_emergencia_idx" ON "emergencia_historial" ("emergencia_id", "created_at");

-- Reglas ------------------------------------------------------------------------------------------------------------
-- Ciclo: activa → controlada → cerrada. (Las migraciones siguientes reemplazan esta función para exigir sus requisitos.) El origen debe ser
-- una SWA que no esté cerrada o un derrame que escale a emergencia mayor; solo se fija al crear.
CREATE FUNCTION "emergencia_validar"() RETURNS trigger LANGUAGE plpgsql SET search_path = qhse, pg_catalog AS $$
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
  IF NEW."estado" = OLD."estado" THEN RETURN NEW; END IF;
  IF (OLD."estado" = 'activa' AND NEW."estado" = 'controlada') OR (OLD."estado" = 'controlada' AND NEW."estado" = 'cerrada') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Cambio de estado no permitido: de % a %', OLD."estado", NEW."estado" USING ERRCODE = 'check_violation';
END
$$;
CREATE TRIGGER "emergencia_validar_trg" BEFORE INSERT OR UPDATE ON "emergencia" FOR EACH ROW EXECUTE FUNCTION "emergencia_validar"();

-- Privilegios: lo reportado no se reescribe; solo avanza el estado (las migraciones siguientes agregan las columnas que se completan) ----
REVOKE UPDATE ON "emergencia" FROM app_qhse;
GRANT UPDATE ("estado", "updated_at", "updated_by") ON "emergencia" TO app_qhse;
REVOKE DELETE ON "emergencia" FROM app_qhse;
REVOKE UPDATE, DELETE ON "emergencia_linea" FROM app_qhse;
REVOKE UPDATE, DELETE ON "emergencia_historial" FROM app_qhse;
REVOKE DELETE ON "emergencia_tipo" FROM app_qhse;

COMMENT ON TABLE "emergencia" IS 'Plan de Respuesta a Emergencias y MEDEVAC (HSE-TRIAGE-001). La activa cualquier trabajador. Consecutivo EME-000001. Ciclo activa → controlada → cerrada.';
COMMENT ON COLUMN "emergencia"."swa_id" IS 'SWA de la que escaló (riesgo no controlado). FK real, mismo esquema; una SWA escala una sola vez y solo si no está cerrada.';
COMMENT ON COLUMN "emergencia"."derrame_id" IS 'Derrame mayor o en cuerpo de agua del que escaló (HSE-MASTER-001). FK real, mismo esquema; un derrame escala una sola vez.';
COMMENT ON COLUMN "emergencia"."ticket_id" IS 'Servicio durante el que ocurrió (referencia local ticket_ref); nulo si no fue durante un servicio.';
COMMENT ON TABLE "emergencia_linea" IS 'Cronómetro del evento: una línea por acción con la hora del servidor. Las acciones del sistema (nivel, conteo, MEDEVAC...) también dejan su línea (automatica = true). Solo se agrega.';
COMMENT ON TABLE "emergencia_tipo" IS 'Tipos de emergencia (catálogo editable por QHSE). El comportamiento nunca depende del nombre.';
COMMENT ON FUNCTION "derrame_escala_a_emergencia"(UUID) IS 'Verdadero si la ubicación, la banda reportada o la banda del volumen real del derrame escalan a emergencia mayor (HSE-MASTER-001).';
