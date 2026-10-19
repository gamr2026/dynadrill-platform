-- QHSE, tramo Q3-a: Matriz IPERC maestra (DYN-SGI-RE-087, GTC 45). Según la demo y Dynadrill (18/10/2026) la matriz NO es de un pedido: es una
-- matriz MAESTRA por actividad que se aprueba cada año. Una actividad tiene versiones; solo una está aprobada (vigente 12 meses) y editar
-- una aprobada crea una versión nueva que debe aprobarse otra vez mientras sigue valiendo la anterior. Qué actividades exige cada tipo de
-- servicio es la «cobertura». El PTW de un pedido solo avanza si las matrices de esas actividades están aprobadas y vigentes (migración
-- siguiente). Cero JSON: tareas, peligros y controles son tablas; la valoración GTC 45 son tres enteros con sus valores oficiales.

-- Lectura de los archivos adjuntos (procedimiento y ATS base): solo el id (la FK) y que existan; ya se concedió en el tramo de documentos.

CREATE TYPE "estado_iperc" AS ENUM ('borrador', 'en_evaluacion', 'en_revision', 'aprobada', 'rechazada', 'reemplazada');
CREATE TYPE "momento_control_iperc" AS ENUM ('propuesto', 'residual');
CREATE TYPE "tipo_control_iperc" AS ENUM ('eliminacion', 'sustitucion', 'ingenieria', 'administrativo', 'epp');

-- Tipos de servicio que tiene cada ticket (códigos del catálogo de comercial, que llegan por evento): sirven para saber qué cobertura aplica.
CREATE TABLE "ticket_servicio" (
    "ticket_id" UUID NOT NULL,
    "tipo_codigo" TEXT NOT NULL,
    CONSTRAINT "ticket_servicio_pkey" PRIMARY KEY ("ticket_id", "tipo_codigo"),
    CONSTRAINT "ticket_servicio_ticket_fkey" FOREIGN KEY ("ticket_id") REFERENCES "ticket_ref" ("ticket_id") ON DELETE CASCADE,
    CONSTRAINT "ticket_servicio_codigo_check" CHECK (length(btrim("tipo_codigo")) > 0)
);
GRANT DELETE ON "ticket_servicio" TO app_qhse;
COMMENT ON TABLE "ticket_servicio" IS 'Tipos de servicio del ticket, por su código estable de comercial (servicio_tipo.codigo). Se reemplazan con cada evento de Pumping/FCR.';
COMMENT ON COLUMN "ticket_servicio"."tipo_codigo" IS 'Código del tipo de servicio en el contenedor comercial (comercial.servicio_tipo.codigo). Sin FK: otro contenedor (D1).';

-- Catálogos (id, código único, nombre, orden, activo, auditoría) ------------------------------------------------------------
CREATE TABLE "iperc_proceso" (
    "id" UUID NOT NULL, "codigo" TEXT NOT NULL, "nombre" TEXT NOT NULL, "orden" INTEGER NOT NULL, "activo" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_by" UUID,
    CONSTRAINT "iperc_proceso_pkey" PRIMARY KEY ("id"), CONSTRAINT "iperc_proceso_codigo_key" UNIQUE ("codigo"),
    CONSTRAINT "iperc_proceso_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "iperc_proceso_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id"));
CREATE UNIQUE INDEX "iperc_proceso_nombre_key" ON "iperc_proceso" (lower("nombre"));

CREATE TABLE "iperc_zona" (
    "id" UUID NOT NULL, "codigo" TEXT NOT NULL, "nombre" TEXT NOT NULL, "orden" INTEGER NOT NULL, "activo" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_by" UUID,
    CONSTRAINT "iperc_zona_pkey" PRIMARY KEY ("id"), CONSTRAINT "iperc_zona_codigo_key" UNIQUE ("codigo"),
    CONSTRAINT "iperc_zona_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "iperc_zona_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id"));
CREATE UNIQUE INDEX "iperc_zona_nombre_key" ON "iperc_zona" (lower("nombre"));

CREATE TABLE "iperc_clasificacion_peligro" (
    "id" UUID NOT NULL, "codigo" TEXT NOT NULL, "nombre" TEXT NOT NULL, "orden" INTEGER NOT NULL, "activo" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_by" UUID,
    CONSTRAINT "iperc_clasificacion_peligro_pkey" PRIMARY KEY ("id"), CONSTRAINT "iperc_clasificacion_peligro_codigo_key" UNIQUE ("codigo"),
    CONSTRAINT "iperc_clasificacion_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "iperc_clasificacion_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id"));
CREATE UNIQUE INDEX "iperc_clasificacion_nombre_key" ON "iperc_clasificacion_peligro" (lower("nombre"));

CREATE TABLE "iperc_generado_en" (
    "id" UUID NOT NULL, "codigo" TEXT NOT NULL, "nombre" TEXT NOT NULL, "orden" INTEGER NOT NULL, "activo" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_by" UUID,
    CONSTRAINT "iperc_generado_en_pkey" PRIMARY KEY ("id"), CONSTRAINT "iperc_generado_en_codigo_key" UNIQUE ("codigo"),
    CONSTRAINT "iperc_generado_en_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "iperc_generado_en_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id"));
CREATE UNIQUE INDEX "iperc_generado_en_nombre_key" ON "iperc_generado_en" (lower("nombre"));

CREATE TABLE "iperc_cargo" (
    "id" UUID NOT NULL, "codigo" TEXT NOT NULL, "nombre" TEXT NOT NULL, "activo" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_by" UUID,
    CONSTRAINT "iperc_cargo_pkey" PRIMARY KEY ("id"), CONSTRAINT "iperc_cargo_codigo_key" UNIQUE ("codigo"),
    CONSTRAINT "iperc_cargo_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "iperc_cargo_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id"));
CREATE UNIQUE INDEX "iperc_cargo_nombre_key" ON "iperc_cargo" (lower("nombre"));
COMMENT ON TABLE "iperc_cargo" IS 'Cargos expuestos a los peligros de una tarea (columna «Cargos expuestos» del formato). Catálogo propio de QHSE: los cargos del formato no coinciden con los roles del portal.';

-- Actividad maestra ----------------------------------------------------------------------------------------------------------
CREATE TABLE "iperc_actividad" (
    "id" UUID NOT NULL,
    "proceso_id" UUID NOT NULL,
    "zona_id" UUID NOT NULL,
    "nombre" TEXT NOT NULL,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_by" UUID,
    CONSTRAINT "iperc_actividad_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "iperc_actividad_proceso_fkey" FOREIGN KEY ("proceso_id") REFERENCES "iperc_proceso" ("id"),
    CONSTRAINT "iperc_actividad_zona_fkey" FOREIGN KEY ("zona_id") REFERENCES "iperc_zona" ("id"),
    CONSTRAINT "iperc_actividad_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "iperc_actividad_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "iperc_actividad_nombre_check" CHECK (length(btrim("nombre")) > 0));
CREATE UNIQUE INDEX "iperc_actividad_unica_key" ON "iperc_actividad" ("proceso_id", "zona_id", lower("nombre"));
COMMENT ON TABLE "iperc_actividad" IS 'Actividad de la matriz maestra (una por proceso, zona y nombre). Su matriz se versiona y se aprueba cada año.';

-- Matriz (versión) de una actividad --------------------------------------------------------------------------------------------
CREATE TABLE "iperc_matriz" (
    "id" UUID NOT NULL,
    "numero" INTEGER GENERATED ALWAYS AS IDENTITY,
    "actividad_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "estado" "estado_iperc" NOT NULL DEFAULT 'borrador',
    "origen_ticket_id" UUID,
    "procedimiento_archivo_id" UUID,
    "ats_archivo_id" UUID,
    "aprobada_por" UUID,
    "aprobada_at" TIMESTAMPTZ(6),
    "aprobada_el" DATE,
    "vigente_hasta" DATE,
    "rechazada_por" UUID,
    "rechazada_at" TIMESTAMPTZ(6),
    "motivo_rechazo" TEXT,
    "reemplazada_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_by" UUID,
    CONSTRAINT "iperc_matriz_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "iperc_matriz_version_key" UNIQUE ("actividad_id", "version"),
    CONSTRAINT "iperc_matriz_actividad_fkey" FOREIGN KEY ("actividad_id") REFERENCES "iperc_actividad" ("id"),
    CONSTRAINT "iperc_matriz_origen_fkey" FOREIGN KEY ("origen_ticket_id") REFERENCES "ticket_ref" ("ticket_id"),
    CONSTRAINT "iperc_matriz_procedimiento_fkey" FOREIGN KEY ("procedimiento_archivo_id") REFERENCES archivos.archivo ("id"),
    CONSTRAINT "iperc_matriz_ats_fkey" FOREIGN KEY ("ats_archivo_id") REFERENCES archivos.archivo ("id"),
    CONSTRAINT "iperc_matriz_aprobada_por_fkey" FOREIGN KEY ("aprobada_por") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "iperc_matriz_rechazada_por_fkey" FOREIGN KEY ("rechazada_por") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "iperc_matriz_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "iperc_matriz_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "iperc_matriz_version_check" CHECK ("version" >= 1),
    -- la aprobación trae quién, cuándo y su vigencia de 12 meses; solo las aprobadas y las reemplazadas la tienen
    CONSTRAINT "iperc_matriz_aprobacion_check" CHECK (
      ("estado" IN ('aprobada', 'reemplazada')
        AND "aprobada_por" IS NOT NULL AND "aprobada_at" IS NOT NULL AND "aprobada_el" IS NOT NULL AND "vigente_hasta" IS NOT NULL
        AND "procedimiento_archivo_id" IS NOT NULL AND "ats_archivo_id" IS NOT NULL)
      OR ("estado" NOT IN ('aprobada', 'reemplazada')
        AND "aprobada_por" IS NULL AND "aprobada_at" IS NULL AND "aprobada_el" IS NULL AND "vigente_hasta" IS NULL)),
    CONSTRAINT "iperc_matriz_vigencia_check" CHECK ("vigente_hasta" IS NULL OR "vigente_hasta" = ("aprobada_el" + INTERVAL '1 year')::date),
    CONSTRAINT "iperc_matriz_rechazo_check" CHECK (
      ("estado" = 'rechazada' AND "rechazada_por" IS NOT NULL AND "rechazada_at" IS NOT NULL AND length(btrim(coalesce("motivo_rechazo", ''))) > 0)
      OR ("estado" <> 'rechazada' AND "rechazada_por" IS NULL AND "rechazada_at" IS NULL AND "motivo_rechazo" IS NULL)),
    CONSTRAINT "iperc_matriz_reemplazo_check" CHECK (("estado" = 'reemplazada') = ("reemplazada_at" IS NOT NULL)));
CREATE INDEX "iperc_matriz_estado_idx" ON "iperc_matriz" ("estado");
-- Una sola matriz aprobada por actividad y una sola versión en trabajo (borrador, evaluación, revisión o rechazada).
CREATE UNIQUE INDEX "iperc_matriz_aprobada_key" ON "iperc_matriz" ("actividad_id") WHERE "estado" = 'aprobada';
CREATE UNIQUE INDEX "iperc_matriz_en_trabajo_key" ON "iperc_matriz" ("actividad_id")
  WHERE "estado" IN ('borrador', 'en_evaluacion', 'en_revision', 'rechazada');

-- Equipo evaluador (cuentas del portal) ------------------------------------------------------------------------------------------
CREATE TABLE "iperc_matriz_evaluador" (
    "matriz_id" UUID NOT NULL, "usuario_id" UUID NOT NULL,
    CONSTRAINT "iperc_matriz_evaluador_pkey" PRIMARY KEY ("matriz_id", "usuario_id"),
    CONSTRAINT "iperc_matriz_evaluador_matriz_fkey" FOREIGN KEY ("matriz_id") REFERENCES "iperc_matriz" ("id") ON DELETE CASCADE,
    CONSTRAINT "iperc_matriz_evaluador_usuario_fkey" FOREIGN KEY ("usuario_id") REFERENCES identidad.usuario ("id"));
GRANT DELETE ON "iperc_matriz_evaluador" TO app_qhse;

-- Tareas, peligros y controles -----------------------------------------------------------------------------------------------------
CREATE TABLE "iperc_tarea" (
    "id" UUID NOT NULL,
    "matriz_id" UUID NOT NULL,
    "orden" INTEGER NOT NULL,
    "descripcion" TEXT NOT NULL,
    "rutinaria" BOOLEAN NOT NULL DEFAULT true,
    "area_puesto" TEXT,
    CONSTRAINT "iperc_tarea_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "iperc_tarea_orden_key" UNIQUE ("matriz_id", "orden"),
    CONSTRAINT "iperc_tarea_matriz_fkey" FOREIGN KEY ("matriz_id") REFERENCES "iperc_matriz" ("id") ON DELETE CASCADE,
    CONSTRAINT "iperc_tarea_descripcion_check" CHECK (length(btrim("descripcion")) > 0));
GRANT DELETE ON "iperc_tarea" TO app_qhse;
COMMENT ON COLUMN "iperc_tarea"."area_puesto" IS 'Área o puesto de trabajo donde se hace la tarea, tal como lo escribe el formato (mezcla puesto y lugar; no hay un catálogo).';

CREATE TABLE "iperc_tarea_cargo" (
    "tarea_id" UUID NOT NULL, "cargo_id" UUID NOT NULL,
    CONSTRAINT "iperc_tarea_cargo_pkey" PRIMARY KEY ("tarea_id", "cargo_id"),
    CONSTRAINT "iperc_tarea_cargo_tarea_fkey" FOREIGN KEY ("tarea_id") REFERENCES "iperc_tarea" ("id") ON DELETE CASCADE,
    CONSTRAINT "iperc_tarea_cargo_cargo_fkey" FOREIGN KEY ("cargo_id") REFERENCES "iperc_cargo" ("id"));
GRANT DELETE ON "iperc_tarea_cargo" TO app_qhse;

CREATE TABLE "iperc_peligro" (
    "id" UUID NOT NULL,
    "tarea_id" UUID NOT NULL,
    "orden" INTEGER NOT NULL,
    "descripcion" TEXT NOT NULL,
    "clasificacion_id" UUID NOT NULL,
    "fuente_riesgo" TEXT,
    "generado_en_id" UUID,
    "efectos_posibles" TEXT,
    "control_existente_fuente" TEXT,
    "control_existente_medio" TEXT,
    "control_existente_individuo" TEXT,
    "numero_expuestos" INTEGER,
    "peor_consecuencia" TEXT,
    "requisito_legal" BOOLEAN NOT NULL DEFAULT false,
    "seguimiento" TEXT,
    "seguimiento_residual" TEXT,
    "inicial_nd" INTEGER, "inicial_ne" INTEGER, "inicial_nc" INTEGER,
    "residual_nd" INTEGER, "residual_ne" INTEGER, "residual_nc" INTEGER,
    CONSTRAINT "iperc_peligro_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "iperc_peligro_orden_key" UNIQUE ("tarea_id", "orden"),
    CONSTRAINT "iperc_peligro_tarea_fkey" FOREIGN KEY ("tarea_id") REFERENCES "iperc_tarea" ("id") ON DELETE CASCADE,
    CONSTRAINT "iperc_peligro_clasificacion_fkey" FOREIGN KEY ("clasificacion_id") REFERENCES "iperc_clasificacion_peligro" ("id"),
    CONSTRAINT "iperc_peligro_generado_en_fkey" FOREIGN KEY ("generado_en_id") REFERENCES "iperc_generado_en" ("id"),
    CONSTRAINT "iperc_peligro_descripcion_check" CHECK (length(btrim("descripcion")) > 0),
    CONSTRAINT "iperc_peligro_expuestos_check" CHECK ("numero_expuestos" IS NULL OR "numero_expuestos" >= 0),
    -- valores oficiales de la GTC 45: deficiencia 0/2/6/10, exposición 1 a 4, consecuencia 10/25/60/100; los tres o ninguno
    CONSTRAINT "iperc_peligro_inicial_check" CHECK (
      ("inicial_nd" IS NULL AND "inicial_ne" IS NULL AND "inicial_nc" IS NULL)
      OR ("inicial_nd" IN (0, 2, 6, 10) AND "inicial_ne" IN (1, 2, 3, 4) AND "inicial_nc" IN (10, 25, 60, 100))),
    CONSTRAINT "iperc_peligro_residual_check" CHECK (
      ("residual_nd" IS NULL AND "residual_ne" IS NULL AND "residual_nc" IS NULL)
      OR ("residual_nd" IN (0, 2, 6, 10) AND "residual_ne" IN (1, 2, 3, 4) AND "residual_nc" IN (10, 25, 60, 100))));
CREATE INDEX "iperc_peligro_clasificacion_idx" ON "iperc_peligro" ("clasificacion_id");
GRANT DELETE ON "iperc_peligro" TO app_qhse;
COMMENT ON COLUMN "iperc_peligro"."descripcion" IS 'Peligro identificado (con el código de la tabla de peligros del formato, p. ej. «4.6 Exposición a gases y vapores»).';
COMMENT ON COLUMN "iperc_peligro"."inicial_nd" IS 'Nivel de deficiencia del riesgo inicial. NP = ND×NE y NR = NP×NC se calculan al consultar (no se guardan: son derivados).';

CREATE TABLE "iperc_control" (
    "id" UUID NOT NULL,
    "peligro_id" UUID NOT NULL,
    "momento" "momento_control_iperc" NOT NULL,
    "tipo" "tipo_control_iperc" NOT NULL,
    "descripcion" TEXT NOT NULL,
    CONSTRAINT "iperc_control_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "iperc_control_peligro_fkey" FOREIGN KEY ("peligro_id") REFERENCES "iperc_peligro" ("id") ON DELETE CASCADE,
    CONSTRAINT "iperc_control_descripcion_check" CHECK (length(btrim("descripcion")) > 0));
CREATE INDEX "iperc_control_peligro_idx" ON "iperc_control" ("peligro_id");
GRANT DELETE ON "iperc_control" TO app_qhse;
COMMENT ON COLUMN "iperc_control"."momento" IS 'propuesto = medidas de intervención que define la evaluación; residual = controles con los que queda el riesgo residual.';

-- Cobertura: qué actividades exige cada tipo de servicio --------------------------------------------------------------------------
CREATE TABLE "iperc_cobertura" (
    "tipo_servicio_codigo" TEXT NOT NULL,
    "actividad_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "created_by" UUID NOT NULL,
    CONSTRAINT "iperc_cobertura_pkey" PRIMARY KEY ("tipo_servicio_codigo", "actividad_id"),
    CONSTRAINT "iperc_cobertura_actividad_fkey" FOREIGN KEY ("actividad_id") REFERENCES "iperc_actividad" ("id"),
    CONSTRAINT "iperc_cobertura_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "iperc_cobertura_codigo_check" CHECK (length(btrim("tipo_servicio_codigo")) > 0));
CREATE INDEX "iperc_cobertura_actividad_idx" ON "iperc_cobertura" ("actividad_id");
GRANT DELETE ON "iperc_cobertura" TO app_qhse;
COMMENT ON COLUMN "iperc_cobertura"."tipo_servicio_codigo" IS 'Código del tipo de servicio en el contenedor comercial (comercial.servicio_tipo.codigo). Sin FK: otro contenedor (D1).';

CREATE TABLE "iperc_historial" (
    "id" UUID NOT NULL,
    "matriz_id" UUID NOT NULL,
    "estado_anterior" "estado_iperc",
    "estado_nuevo" "estado_iperc" NOT NULL,
    "motivo" TEXT,
    "actor_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "iperc_historial_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "iperc_historial_matriz_fkey" FOREIGN KEY ("matriz_id") REFERENCES "iperc_matriz" ("id") ON DELETE CASCADE,
    CONSTRAINT "iperc_historial_actor_fkey" FOREIGN KEY ("actor_id") REFERENCES identidad.usuario ("id"));
CREATE INDEX "iperc_historial_matriz_idx" ON "iperc_historial" ("matriz_id", "created_at");

-- ---------------------------------------------------------------------------------------------------------------
-- Reglas del ciclo de la matriz
-- ---------------------------------------------------------------------------------------------------------------
CREATE FUNCTION "iperc_matriz_validar"() RETURNS trigger LANGUAGE plpgsql SET search_path = qhse, pg_catalog AS $$
DECLARE
  v_incompletos INTEGER;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."estado" <> 'borrador' THEN
      RAISE EXCEPTION 'Una matriz nace en borrador' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- una matriz aprobada es un documento firmado: solo puede pasar a reemplazada; una reemplazada no cambia
  IF OLD."estado" = 'reemplazada' THEN
    RAISE EXCEPTION 'Una matriz reemplazada no se puede cambiar' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."estado" = 'aprobada' THEN
    IF NEW."estado" <> 'reemplazada' THEN
      RAISE EXCEPTION 'Una matriz aprobada no se puede cambiar: cree una versión nueva' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."estado" = OLD."estado" THEN RETURN NEW; END IF;

  IF OLD."estado" = 'borrador' AND NEW."estado" = 'en_evaluacion' THEN RETURN NEW; END IF;
  IF OLD."estado" = 'rechazada' AND NEW."estado" = 'en_evaluacion' THEN RETURN NEW; END IF;

  IF OLD."estado" = 'en_evaluacion' AND NEW."estado" = 'en_revision' THEN
    IF NOT EXISTS (SELECT 1 FROM "iperc_tarea" WHERE "matriz_id" = NEW."id") THEN
      RAISE EXCEPTION 'La matriz no tiene tareas' USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM "iperc_tarea" t WHERE t."matriz_id" = NEW."id" AND NOT EXISTS (SELECT 1 FROM "iperc_peligro" p WHERE p."tarea_id" = t."id")) THEN
      RAISE EXCEPTION 'Hay tareas sin peligros identificados' USING ERRCODE = 'check_violation';
    END IF;
    SELECT count(*) INTO v_incompletos FROM "iperc_peligro" p JOIN "iperc_tarea" t ON t."id" = p."tarea_id"
     WHERE t."matriz_id" = NEW."id" AND (p."inicial_nd" IS NULL OR p."residual_nd" IS NULL);
    IF v_incompletos > 0 THEN
      RAISE EXCEPTION 'Faltan la valoración inicial o la residual de % peligro(s)', v_incompletos USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."estado" = 'en_revision' AND NEW."estado" IN ('aprobada', 'rechazada') THEN
    -- los demás requisitos (procedimiento, ATS, quién y cuándo) los exigen los CHECK de la tabla
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Cambio de estado no permitido: de % a %', OLD."estado", NEW."estado" USING ERRCODE = 'check_violation';
END
$$;
CREATE TRIGGER "iperc_matriz_validar_trg" BEFORE INSERT OR UPDATE ON "iperc_matriz" FOR EACH ROW EXECUTE FUNCTION "iperc_matriz_validar"();

-- El contenido (tareas, peligros, controles, cargos, equipo) solo cambia con la matriz en borrador o en evaluación.
CREATE FUNCTION "iperc_contenido_editable"() RETURNS trigger LANGUAGE plpgsql SET search_path = qhse, pg_catalog AS $$
DECLARE
  v_matriz UUID;
  v_estado "estado_iperc";
  v_fila RECORD;
BEGIN
  v_fila := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  v_matriz := CASE TG_TABLE_NAME
    WHEN 'iperc_tarea' THEN v_fila."matriz_id"
    WHEN 'iperc_matriz_evaluador' THEN v_fila."matriz_id"
    WHEN 'iperc_tarea_cargo' THEN (SELECT "matriz_id" FROM "iperc_tarea" WHERE "id" = v_fila."tarea_id")
    WHEN 'iperc_peligro' THEN (SELECT "matriz_id" FROM "iperc_tarea" WHERE "id" = v_fila."tarea_id")
    WHEN 'iperc_control' THEN (SELECT t."matriz_id" FROM "iperc_peligro" p JOIN "iperc_tarea" t ON t."id" = p."tarea_id" WHERE p."id" = v_fila."peligro_id")
  END;
  SELECT "estado" INTO v_estado FROM "iperc_matriz" WHERE "id" = v_matriz;
  -- al borrar la matriz entera (solo pruebas, con dyn_migrator) la fila padre ya no existe
  IF v_estado IS NULL THEN RETURN v_fila; END IF;
  IF v_estado NOT IN ('borrador', 'en_evaluacion') THEN
    RAISE EXCEPTION 'El contenido de la matriz no se puede cambiar (está %): una aprobada se revisa con una versión nueva', v_estado USING ERRCODE = 'check_violation';
  END IF;
  RETURN v_fila;
END
$$;
CREATE TRIGGER "iperc_tarea_editable_trg" BEFORE INSERT OR UPDATE OR DELETE ON "iperc_tarea" FOR EACH ROW EXECUTE FUNCTION "iperc_contenido_editable"();
CREATE TRIGGER "iperc_tarea_cargo_editable_trg" BEFORE INSERT OR UPDATE OR DELETE ON "iperc_tarea_cargo" FOR EACH ROW EXECUTE FUNCTION "iperc_contenido_editable"();
CREATE TRIGGER "iperc_peligro_editable_trg" BEFORE INSERT OR UPDATE OR DELETE ON "iperc_peligro" FOR EACH ROW EXECUTE FUNCTION "iperc_contenido_editable"();
CREATE TRIGGER "iperc_control_editable_trg" BEFORE INSERT OR UPDATE OR DELETE ON "iperc_control" FOR EACH ROW EXECUTE FUNCTION "iperc_contenido_editable"();
CREATE TRIGGER "iperc_evaluador_editable_trg" BEFORE INSERT OR UPDATE OR DELETE ON "iperc_matriz_evaluador" FOR EACH ROW EXECUTE FUNCTION "iperc_contenido_editable"();

-- ---------------------------------------------------------------------------------------------------------------
-- Privilegios: de la matriz solo cambian el estado, los adjuntos, la aprobación o el rechazo y la auditoría; la historia no se edita
-- ---------------------------------------------------------------------------------------------------------------
REVOKE UPDATE ON "iperc_matriz" FROM app_qhse;
GRANT UPDATE ("estado", "procedimiento_archivo_id", "ats_archivo_id", "aprobada_por", "aprobada_at", "aprobada_el", "vigente_hasta",
              "rechazada_por", "rechazada_at", "motivo_rechazo", "reemplazada_at", "updated_at", "updated_by") ON "iperc_matriz" TO app_qhse;
REVOKE DELETE ON "iperc_matriz" FROM app_qhse;
REVOKE UPDATE, DELETE ON "iperc_historial" FROM app_qhse;

COMMENT ON TABLE "iperc_matriz" IS 'Versión de la matriz IPERC de una actividad (DYN-SGI-RE-087, GTC 45). Una aprobada vale 12 meses; editarla crea una versión nueva. Trigger iperc_matriz_validar.';
COMMENT ON COLUMN "iperc_matriz"."numero" IS 'Consecutivo interno visible (IPERC-000001); el formato no tiene numeración propia: no pasa por el motor de secuenciales de plataforma.';
COMMENT ON COLUMN "iperc_matriz"."origen_ticket_id" IS 'Ticket desde el que se pidió esta matriz (la actividad aún no la tenía). Referencia local ticket_ref.';
COMMENT ON COLUMN "iperc_matriz"."vigente_hasta" IS 'Aprobación + 12 meses (lo exige iperc_matriz_vigencia_check). Pasada esta fecha el PTW que la necesita queda bloqueado hasta aprobar una versión nueva.';
COMMENT ON TABLE "iperc_historial" IS 'Rastro de cada cambio de estado de una matriz. Solo se agrega.';
