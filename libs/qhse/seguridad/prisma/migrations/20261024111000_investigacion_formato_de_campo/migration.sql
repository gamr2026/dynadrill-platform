-- QHSE, investigación de incidentes, rebanada 2: lo que el formato DYN-SGI-RE-034 pide de campo. Trabajador involucrado (solo si hubo lesionado),
-- información del incidente, equipo investigador, testigos (máximo 3) y factores del entorno de trabajo. Todo se edita mientras la investigación
-- está abierta o en investigación; después queda congelado (la base lo impide, no solo el servicio).

CREATE TYPE "jornada_suceso" AS ENUM ('ordinaria', 'extra', 'suplementaria');
CREATE TYPE "zona_incidente" AS ENUM ('rural', 'urbana');
CREATE TYPE "sexo_persona" AS ENUM ('masculino', 'femenino');

ALTER TABLE "investigacion" ADD COLUMN "evidencias_recopiladas" TEXT, ADD COLUMN "testimonios_resumen" TEXT;
GRANT UPDATE ("evidencias_recopiladas", "testimonios_resumen") ON "investigacion" TO app_qhse;

-- ---------------------------------------------------------------------------------------------------------------
-- Trabajador involucrado (1:1). Cuenta del portal (nombre, cédula y cargo salen de identidad por JOIN) o persona externa con sus datos.
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE "investigacion_trabajador" (
    "investigacion_id" UUID NOT NULL,
    "usuario_id" UUID,
    "apellidos_nombres" TEXT,
    "cedula" TEXT,
    "cargo" TEXT,
    "direccion" TEXT,
    "telefono" TEXT,
    "fecha_nacimiento" DATE,
    "sexo" "sexo_persona",
    "fecha_ingreso" DATE,
    "tipo_vinculacion" TEXT,
    "oficio_desempenaba" TEXT,
    "jornada_habitual" TEXT,
    "tiempo_experiencia_meses" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_by" UUID,
    CONSTRAINT "investigacion_trabajador_pkey" PRIMARY KEY ("investigacion_id"),
    CONSTRAINT "investigacion_trabajador_investigacion_fkey" FOREIGN KEY ("investigacion_id") REFERENCES "investigacion" ("id"),
    CONSTRAINT "investigacion_trabajador_usuario_fkey" FOREIGN KEY ("usuario_id") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "investigacion_trabajador_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "investigacion_trabajador_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id"),
    -- una cuenta del portal no copia sus datos; una persona externa los trae completos
    CONSTRAINT "investigacion_trabajador_identidad_check" CHECK (
      ("usuario_id" IS NOT NULL AND "apellidos_nombres" IS NULL AND "cedula" IS NULL AND "cargo" IS NULL)
      OR ("usuario_id" IS NULL AND length(btrim(coalesce("apellidos_nombres", ''))) > 0 AND length(btrim(coalesce("cedula", ''))) > 0)),
    CONSTRAINT "investigacion_trabajador_experiencia_check" CHECK ("tiempo_experiencia_meses" IS NULL OR "tiempo_experiencia_meses" >= 0));

COMMENT ON TABLE "investigacion_trabajador" IS '«Datos del trabajador involucrado» del formato DYN-SGI-RE-034. Solo existe si el resultado del incidente involucra a un lesionado.';
COMMENT ON COLUMN "investigacion_trabajador"."usuario_id" IS 'Cuenta del portal: el nombre, la cédula y el cargo se leen de identidad por JOIN (no se copian). Sin cuenta, se llenan apellidos_nombres y cedula.';
COMMENT ON COLUMN "investigacion_trabajador"."tipo_vinculacion" IS 'Texto del formato (el formato físico lo deja abierto: relación de dependencia, contratista, etc.).';
COMMENT ON COLUMN "investigacion_trabajador"."jornada_habitual" IS 'Texto del formato (horario habitual escrito por quien llena el reporte).';

-- ---------------------------------------------------------------------------------------------------------------
-- Información sobre el incidente o accidente (1:1). La fecha y la hora de ocurrencia son las de `investigacion.fecha_incidente`.
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE "investigacion_detalle" (
    "investigacion_id" UUID NOT NULL,
    "jornada_suceso" "jornada_suceso",
    "empresa_donde_ocurrio" TEXT,
    "direccion_ocurrencia" TEXT,
    "zona" "zona_incidente",
    "oficio_era_propio_del_cargo" BOOLEAN,
    "hora_inicio_jornada" TIME(0),
    "tiempo_laborado_previo_horas" DECIMAL(5,2),
    "se_informo_oportunamente" BOOLEAN,
    "tiempo_atencion_medica" TEXT,
    "centro_medico" TEXT,
    "causo_muerte" BOOLEAN NOT NULL DEFAULT false,
    "fecha_muerte" DATE,
    "parte_cuerpo_afectada" TEXT,
    "tipo_lesion_sufrida" TEXT,
    "factor_que_origino" TEXT,
    "total_dias_incapacidad" INTEGER,
    "continua_incapacitado" BOOLEAN,
    "sucesos_similares_previos" BOOLEAN,
    "sucesos_similares_detalle" TEXT,
    "danos_materiales" TEXT,
    "total_perdidas_economicas" DECIMAL(14,2),
    "danos_medio_ambiente" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_by" UUID,
    CONSTRAINT "investigacion_detalle_pkey" PRIMARY KEY ("investigacion_id"),
    CONSTRAINT "investigacion_detalle_investigacion_fkey" FOREIGN KEY ("investigacion_id") REFERENCES "investigacion" ("id"),
    CONSTRAINT "investigacion_detalle_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "investigacion_detalle_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "investigacion_detalle_muerte_check" CHECK (("causo_muerte" AND "fecha_muerte" IS NOT NULL) OR (NOT "causo_muerte" AND "fecha_muerte" IS NULL)),
    CONSTRAINT "investigacion_detalle_similares_check" CHECK ("sucesos_similares_detalle" IS NULL OR "sucesos_similares_previos" IS TRUE),
    CONSTRAINT "investigacion_detalle_cifras_check" CHECK (
      ("total_dias_incapacidad" IS NULL OR "total_dias_incapacidad" >= 0)
      AND ("total_perdidas_economicas" IS NULL OR "total_perdidas_economicas" >= 0)
      AND ("tiempo_laborado_previo_horas" IS NULL OR ("tiempo_laborado_previo_horas" >= 0 AND "tiempo_laborado_previo_horas" <= 24))));

COMMENT ON TABLE "investigacion_detalle" IS '«Información sobre el incidente o accidente» del formato DYN-SGI-RE-034. Los datos de la lesión solo caben si el resultado involucra a un lesionado.';
COMMENT ON COLUMN "investigacion_detalle"."total_dias_incapacidad" IS 'Días de incapacidad (insumo del TRIR/LTIR del dashboard HSE-MASTER-001 y del criterio de notificación legal: más de 3 días).';
COMMENT ON COLUMN "investigacion_detalle"."tiempo_atencion_medica" IS 'Texto del formato (cuánto tardó la atención, como lo escribe quien llena el reporte).';

-- ---------------------------------------------------------------------------------------------------------------
-- Listas: equipo investigador, testigos (máximo 3) y factores del entorno de trabajo
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE "investigacion_equipo" (
    "id" UUID NOT NULL,
    "investigacion_id" UUID NOT NULL,
    "usuario_id" UUID,
    "nombre_externo" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_by" UUID,
    CONSTRAINT "investigacion_equipo_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "investigacion_equipo_investigacion_fkey" FOREIGN KEY ("investigacion_id") REFERENCES "investigacion" ("id"),
    CONSTRAINT "investigacion_equipo_usuario_fkey" FOREIGN KEY ("usuario_id") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "investigacion_equipo_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "investigacion_equipo_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id"),
    -- un miembro es una cuenta del portal o una persona externa (p. ej. del cliente), nunca las dos
    CONSTRAINT "investigacion_equipo_miembro_check" CHECK (
      ("usuario_id" IS NOT NULL AND "nombre_externo" IS NULL)
      OR ("usuario_id" IS NULL AND length(btrim(coalesce("nombre_externo", ''))) > 0)));
CREATE UNIQUE INDEX "investigacion_equipo_usuario_key" ON "investigacion_equipo" ("investigacion_id", "usuario_id") WHERE "usuario_id" IS NOT NULL;
CREATE UNIQUE INDEX "investigacion_equipo_externo_key" ON "investigacion_equipo" ("investigacion_id", lower(btrim("nombre_externo"))) WHERE "nombre_externo" IS NOT NULL;
CREATE INDEX "investigacion_equipo_investigacion_idx" ON "investigacion_equipo" ("investigacion_id");

COMMENT ON TABLE "investigacion_equipo" IS 'Equipo investigador multidisciplinario (HSE, Operaciones, Mantenimiento, Cliente): cuentas del portal o personas externas.';

CREATE TABLE "investigacion_testigo" (
    "id" UUID NOT NULL,
    "investigacion_id" UUID NOT NULL,
    "orden" INTEGER NOT NULL,
    "nombres_apellidos" TEXT NOT NULL,
    "cedula" TEXT,
    "version" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_by" UUID,
    CONSTRAINT "investigacion_testigo_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "investigacion_testigo_investigacion_fkey" FOREIGN KEY ("investigacion_id") REFERENCES "investigacion" ("id"),
    CONSTRAINT "investigacion_testigo_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "investigacion_testigo_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "investigacion_testigo_orden_key" UNIQUE ("investigacion_id", "orden"),
    -- el formato físico admite hasta 3 testigos
    CONSTRAINT "investigacion_testigo_orden_check" CHECK ("orden" BETWEEN 1 AND 3),
    CONSTRAINT "investigacion_testigo_texto_check" CHECK (length(btrim("nombres_apellidos")) > 0 AND length(btrim("version")) > 0));

COMMENT ON TABLE "investigacion_testigo" IS 'Testigos del incidente (el formato admite hasta 3) con su versión del relato.';

CREATE TABLE "investigacion_entorno_factor" (
    "id" UUID NOT NULL,
    "investigacion_id" UUID NOT NULL,
    "orden" INTEGER NOT NULL,
    "tipo" TEXT NOT NULL,
    "fuente" TEXT NOT NULL,
    "existe_control" BOOLEAN NOT NULL,
    "contribuyo_al_suceso" BOOLEAN NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_by" UUID,
    CONSTRAINT "investigacion_entorno_factor_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "investigacion_entorno_factor_investigacion_fkey" FOREIGN KEY ("investigacion_id") REFERENCES "investigacion" ("id"),
    CONSTRAINT "investigacion_entorno_factor_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "investigacion_entorno_factor_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "investigacion_entorno_factor_orden_key" UNIQUE ("investigacion_id", "orden"),
    CONSTRAINT "investigacion_entorno_factor_orden_check" CHECK ("orden" >= 1),
    CONSTRAINT "investigacion_entorno_factor_texto_check" CHECK (length(btrim("tipo")) > 0 AND length(btrim("fuente")) > 0));

COMMENT ON TABLE "investigacion_entorno_factor" IS 'Factores de riesgo presentes en la estación de trabajo (tabla «Entorno de trabajo» del formato).';
COMMENT ON COLUMN "investigacion_entorno_factor"."existe_control" IS 'Si existía un control para ese factor. La demo lo guardaba como texto; es una respuesta sí o no.';

-- ---------------------------------------------------------------------------------------------------------------
-- Reglas: solo se edita mientras la investigación está abierta o en investigación
-- ---------------------------------------------------------------------------------------------------------------
CREATE FUNCTION "investigacion_hijo_editable"() RETURNS trigger LANGUAGE plpgsql SET search_path = qhse, pg_catalog AS $$
DECLARE v_estado "estado_investigacion";
BEGIN
  SELECT "estado" INTO v_estado FROM "investigacion" WHERE "id" = COALESCE(NEW."investigacion_id", OLD."investigacion_id");
  IF v_estado NOT IN ('abierta', 'en_investigacion') THEN
    RAISE EXCEPTION 'La investigación ya no admite cambios' USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END
$$;
CREATE TRIGGER "investigacion_trabajador_editable_trg" BEFORE INSERT OR UPDATE OR DELETE ON "investigacion_trabajador" FOR EACH ROW EXECUTE FUNCTION "investigacion_hijo_editable"();
CREATE TRIGGER "investigacion_detalle_editable_trg" BEFORE INSERT OR UPDATE OR DELETE ON "investigacion_detalle" FOR EACH ROW EXECUTE FUNCTION "investigacion_hijo_editable"();
CREATE TRIGGER "investigacion_equipo_editable_trg" BEFORE INSERT OR UPDATE OR DELETE ON "investigacion_equipo" FOR EACH ROW EXECUTE FUNCTION "investigacion_hijo_editable"();
CREATE TRIGGER "investigacion_testigo_editable_trg" BEFORE INSERT OR UPDATE OR DELETE ON "investigacion_testigo" FOR EACH ROW EXECUTE FUNCTION "investigacion_hijo_editable"();
CREATE TRIGGER "investigacion_entorno_factor_editable_trg" BEFORE INSERT OR UPDATE OR DELETE ON "investigacion_entorno_factor" FOR EACH ROW EXECUTE FUNCTION "investigacion_hijo_editable"();

-- El trabajador y los datos de la lesión solo caben si el resultado del incidente involucra a un lesionado.
CREATE FUNCTION "investigacion_lesionado_validar"() RETURNS trigger LANGUAGE plpgsql SET search_path = qhse, pg_catalog AS $$
DECLARE v_lesionado BOOLEAN;
BEGIN
  SELECT r."involucra_lesionado" INTO v_lesionado
    FROM "investigacion" i JOIN "investigacion_resultado" r ON r."id" = i."resultado_id" WHERE i."id" = NEW."investigacion_id";
  IF v_lesionado THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME = 'investigacion_trabajador' THEN
    RAISE EXCEPTION 'Este resultado no involucra a un trabajador lesionado: no lleva datos del trabajador' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."causo_muerte" OR NEW."fecha_muerte" IS NOT NULL OR NEW."parte_cuerpo_afectada" IS NOT NULL OR NEW."tipo_lesion_sufrida" IS NOT NULL
     OR NEW."total_dias_incapacidad" IS NOT NULL OR NEW."continua_incapacitado" IS NOT NULL OR NEW."centro_medico" IS NOT NULL
     OR NEW."tiempo_atencion_medica" IS NOT NULL THEN
    RAISE EXCEPTION 'Este resultado no involucra a un lesionado: no lleva datos de la lesión' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "investigacion_trabajador_lesionado_trg" BEFORE INSERT OR UPDATE ON "investigacion_trabajador" FOR EACH ROW EXECUTE FUNCTION "investigacion_lesionado_validar"();
CREATE TRIGGER "investigacion_detalle_lesionado_trg" BEFORE INSERT OR UPDATE ON "investigacion_detalle" FOR EACH ROW EXECUTE FUNCTION "investigacion_lesionado_validar"();

-- Las evidencias y los testimonios de la cabecera tampoco se editan fuera de abierta o en investigación (se reemplaza la función de la migración anterior).
CREATE OR REPLACE FUNCTION "investigacion_validar"() RETURNS trigger LANGUAGE plpgsql SET search_path = qhse, pg_catalog AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."estado" <> 'abierta' THEN RAISE EXCEPTION 'Una investigación nace abierta' USING ERRCODE = 'check_violation'; END IF;
    RETURN NEW;
  END IF;
  IF NEW."resultado_id" <> OLD."resultado_id" OR NEW."fecha_incidente" <> OLD."fecha_incidente"
     OR NEW."descripcion_evento" <> OLD."descripcion_evento" OR NEW."ubicacion" <> OLD."ubicacion"
     OR NEW."origen_emergencia_id" IS DISTINCT FROM OLD."origen_emergencia_id" THEN
    RAISE EXCEPTION 'El resultado, la fecha, la descripción, la ubicación y el origen del incidente no se cambian' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."evidencias_recopiladas" IS DISTINCT FROM OLD."evidencias_recopiladas" OR NEW."testimonios_resumen" IS DISTINCT FROM OLD."testimonios_resumen")
     AND OLD."estado" NOT IN ('abierta', 'en_investigacion') THEN
    RAISE EXCEPTION 'La investigación ya no admite cambios' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."estado" = OLD."estado" THEN RETURN NEW; END IF;
  IF OLD."estado" = 'abierta' AND NEW."estado" = 'en_investigacion' THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Cambio de estado no permitido: de % a %', OLD."estado", NEW."estado" USING ERRCODE = 'check_violation';
END
$$;
