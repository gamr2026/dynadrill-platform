-- QHSE, tramo Q4: Derrames (HSE-AMBIENTAL-002). Esta migración trae el registro del derrame: la alerta que activa cualquier trabajador, con su
-- ubicación, la banda de volumen reportada y el servicio (ticket) opcional. La contención, la notificación al MAE y el desecho generado llegan en
-- las migraciones siguientes.
--
-- Los UMBRALES DE LAS BANDAS DE VOLUMEN SON UN SUPUESTO DE LA DEMO (menor < 1, moderado 1-5, mayor > 5 barriles): se modelan como datos
-- configurables y quedan marcados `por_confirmar` hasta que Dynadrill los confirme (plan-qhse.md §10). No son definitivos.

CREATE TYPE "estado_derrame" AS ENUM ('activo', 'contenido', 'cerrado');

-- Catálogos ------------------------------------------------------------------------------------------------------
-- Dónde cayó el derrame. El comportamiento sale de columnas, nunca del nombre.
CREATE TABLE "derrame_ubicacion" (
    "id" UUID NOT NULL,
    "codigo" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "orden" INTEGER NOT NULL,
    "exige_notificacion_mae" BOOLEAN NOT NULL DEFAULT false,
    "escala_a_emergencia" BOOLEAN NOT NULL DEFAULT false,
    "genera_desecho" BOOLEAN NOT NULL DEFAULT false,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    CONSTRAINT "derrame_ubicacion_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "derrame_ubicacion_codigo_key" UNIQUE ("codigo"),
    CONSTRAINT "derrame_ubicacion_orden_key" UNIQUE ("orden"),
    CONSTRAINT "derrame_ubicacion_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "derrame_ubicacion_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id")
);

-- Bandas de volumen en barriles, configurables: [desde, hasta). `hasta` vacío = sin tope. Las bandas activas no se solapan.
CREATE TABLE "derrame_banda_volumen" (
    "id" UUID NOT NULL,
    "codigo" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "orden" INTEGER NOT NULL,
    "desde_barriles" NUMERIC(10,3) NOT NULL,
    "hasta_barriles" NUMERIC(10,3),
    "exige_notificacion_mae" BOOLEAN NOT NULL DEFAULT false,
    "escala_a_emergencia" BOOLEAN NOT NULL DEFAULT false,
    "por_confirmar" BOOLEAN NOT NULL DEFAULT true,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    CONSTRAINT "derrame_banda_volumen_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "derrame_banda_volumen_codigo_key" UNIQUE ("codigo"),
    CONSTRAINT "derrame_banda_volumen_orden_key" UNIQUE ("orden"),
    CONSTRAINT "derrame_banda_volumen_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "derrame_banda_volumen_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "derrame_banda_volumen_rango_check" CHECK ("desde_barriles" >= 0 AND ("hasta_barriles" IS NULL OR "hasta_barriles" > "desde_barriles")),
    CONSTRAINT "derrame_banda_volumen_sin_solape" EXCLUDE USING gist (numrange("desde_barriles", "hasta_barriles", '[)') WITH &&) WHERE ("activo")
);

-- El derrame ------------------------------------------------------------------------------------------------------
CREATE TABLE "derrame" (
    "id" UUID NOT NULL,
    "numero" INTEGER GENERATED ALWAYS AS IDENTITY,
    "estado" "estado_derrame" NOT NULL DEFAULT 'activo',
    "ubicacion_id" UUID NOT NULL,
    "banda_id" UUID NOT NULL,
    "descripcion" TEXT NOT NULL,
    "ubicacion_fisica" TEXT,
    "ticket_id" UUID,
    "activado_por" UUID NOT NULL,
    "activado_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    CONSTRAINT "derrame_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "derrame_numero_key" UNIQUE ("numero"),
    CONSTRAINT "derrame_ubicacion_fkey" FOREIGN KEY ("ubicacion_id") REFERENCES "derrame_ubicacion" ("id"),
    CONSTRAINT "derrame_banda_fkey" FOREIGN KEY ("banda_id") REFERENCES "derrame_banda_volumen" ("id"),
    CONSTRAINT "derrame_ticket_fkey" FOREIGN KEY ("ticket_id") REFERENCES "ticket_ref" ("ticket_id"),
    CONSTRAINT "derrame_activado_por_fkey" FOREIGN KEY ("activado_por") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "derrame_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "derrame_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "derrame_descripcion_check" CHECK (length(btrim("descripcion")) > 0)
);
CREATE INDEX "derrame_estado_idx" ON "derrame" ("estado");
CREATE INDEX "derrame_ticket_idx" ON "derrame" ("ticket_id") WHERE "ticket_id" IS NOT NULL;
CREATE INDEX "derrame_ubicacion_idx" ON "derrame" ("ubicacion_id");
CREATE INDEX "derrame_banda_idx" ON "derrame" ("banda_id");

CREATE TABLE "derrame_historial" (
    "id" UUID NOT NULL,
    "derrame_id" UUID NOT NULL,
    "estado_anterior" "estado_derrame",
    "estado_nuevo" "estado_derrame" NOT NULL,
    "actor_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "derrame_historial_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "derrame_historial_derrame_fkey" FOREIGN KEY ("derrame_id") REFERENCES "derrame" ("id") ON DELETE CASCADE,
    CONSTRAINT "derrame_historial_actor_fkey" FOREIGN KEY ("actor_id") REFERENCES identidad.usuario ("id")
);
CREATE INDEX "derrame_historial_derrame_idx" ON "derrame_historial" ("derrame_id", "created_at");

-- Ciclo: activo → contenido → cerrado. (Las migraciones de la contención y de la notificación al MAE reemplazan esta función para exigir
-- sus requisitos.)
CREATE FUNCTION "derrame_validar"() RETURNS trigger LANGUAGE plpgsql SET search_path = qhse, pg_catalog AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."estado" <> 'activo' THEN
      RAISE EXCEPTION 'Un derrame nace activo' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."estado" = OLD."estado" THEN RETURN NEW; END IF;
  IF (OLD."estado" = 'activo' AND NEW."estado" = 'contenido') OR (OLD."estado" = 'contenido' AND NEW."estado" = 'cerrado') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Cambio de estado no permitido: de % a %', OLD."estado", NEW."estado" USING ERRCODE = 'check_violation';
END
$$;
CREATE TRIGGER "derrame_validar_trg" BEFORE INSERT OR UPDATE ON "derrame" FOR EACH ROW EXECUTE FUNCTION "derrame_validar"();

-- Privilegios: lo reportado no se reescribe; solo avanza el estado (las migraciones siguientes agregan las columnas que se completan) ----
REVOKE UPDATE ON "derrame" FROM app_qhse;
GRANT UPDATE ("estado", "updated_at", "updated_by") ON "derrame" TO app_qhse;
REVOKE DELETE ON "derrame" FROM app_qhse;
REVOKE UPDATE, DELETE ON "derrame_historial" FROM app_qhse;

COMMENT ON TABLE "derrame" IS 'Derrame de hidrocarburo o químico (HSE-AMBIENTAL-002). Lo activa cualquier trabajador. Consecutivo DER-000001. Ciclo activo → contenido → cerrado.';
COMMENT ON COLUMN "derrame"."banda_id" IS 'Banda de volumen REPORTADA al activar la alerta; el volumen real lo confirma QHSE después.';
COMMENT ON COLUMN "derrame"."ubicacion_fisica" IS 'Descripción libre del sitio (no hay un catálogo de ubicaciones de locación).';
COMMENT ON COLUMN "derrame"."ticket_id" IS 'Servicio durante el que ocurrió (referencia local ticket_ref); nulo si no fue durante un servicio.';
COMMENT ON TABLE "derrame_ubicacion" IS 'Tipo de ubicación del derrame. exige_notificacion_mae, escala_a_emergencia y genera_desecho definen el comportamiento (nunca el nombre).';
COMMENT ON TABLE "derrame_banda_volumen" IS 'Bandas de volumen CONFIGURABLES en barriles [desde, hasta). Los valores sembrados son un supuesto de la demo y están marcados por_confirmar: Dynadrill debe confirmarlos.';
COMMENT ON COLUMN "derrame_banda_volumen"."por_confirmar" IS 'Verdadero mientras Dynadrill no confirme el umbral (plan-qhse.md §10). QHSE lo pone en falso al configurarlo.';
COMMENT ON TABLE "derrame_historial" IS 'Rastro de cada cambio de estado. Solo se agrega.';
