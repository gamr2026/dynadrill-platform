-- QHSE, tramo Q2-b: Tarjeta STOP (DYN-SGI-RE-008, HSE-SEGUIMIENTO-002) e inspecciones de campo (HSE-SEGUIMIENTO-001). Cualquier trabajador
-- registra una tarjeta STOP o una inspección (permiso `qhse.eventos.reportar`); verlas y gestionarlas es del equipo HSE. Los ítems del formato de la
-- tarjeta, los tipos de equipo y sus criterios de rechazo son catálogos (tablas), no texto fijo en el código.

-- La tarjeta STOP guarda el campo y la operadora del lugar donde se observó: lectura mínima de los catálogos maestros.
GRANT SELECT (id, nombre) ON catalogos.campo TO app_qhse;
GRANT SELECT (id, nombre_comercial) ON catalogos.cliente TO app_qhse;

CREATE TYPE "bloque_stop" AS ENUM ('acciones', 'condiciones');
CREATE TYPE "estado_item_stop" AS ENUM ('seguro', 'inseguro');
CREATE TYPE "estado_stop" AS ENUM ('abierto', 'derivado_mantenimiento', 'derivado_otro', 'resuelto_qhse', 'cerrado');
CREATE TYPE "resultado_inspeccion" AS ENUM ('aprobado', 'rechazado');

-- ---------------------------------------------------------------------------------------------------------------
-- Catálogos de la tarjeta STOP: subcategorías (por bloque) e ítems del formato
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE "stop_subcategoria" (
    "id" UUID NOT NULL, "bloque" "bloque_stop" NOT NULL, "codigo" TEXT NOT NULL, "nombre" TEXT NOT NULL, "orden" INTEGER NOT NULL,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_by" UUID,
    CONSTRAINT "stop_subcategoria_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "stop_subcategoria_codigo_key" UNIQUE ("codigo"),
    CONSTRAINT "stop_subcategoria_orden_key" UNIQUE ("bloque", "orden"),
    CONSTRAINT "stop_subcategoria_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "stop_subcategoria_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id"));

CREATE TABLE "stop_item" (
    "id" UUID NOT NULL, "subcategoria_id" UUID NOT NULL, "nombre" TEXT NOT NULL, "orden" INTEGER NOT NULL,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_by" UUID,
    CONSTRAINT "stop_item_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "stop_item_orden_key" UNIQUE ("subcategoria_id", "orden"),
    CONSTRAINT "stop_item_nombre_key" UNIQUE ("subcategoria_id", "nombre"),
    CONSTRAINT "stop_item_subcategoria_fkey" FOREIGN KEY ("subcategoria_id") REFERENCES "stop_subcategoria" ("id"),
    CONSTRAINT "stop_item_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "stop_item_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id"));

-- ---------------------------------------------------------------------------------------------------------------
-- La tarjeta STOP
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE "stop_tarjeta" (
    "id" UUID NOT NULL,
    "numero" INTEGER GENERATED ALWAYS AS IDENTITY,
    "observador_id" UUID NOT NULL,
    "observado_id" UUID,
    "fecha" DATE NOT NULL,
    "campo_id" UUID,
    "operadora_id" UUID,
    "lugar" TEXT,
    "contacto" TEXT,
    "ticket_id" UUID,
    "foto_archivo_id" UUID,
    "acciones_que_observa" TEXT,
    "acciones_accion" TEXT,
    "condiciones_que_observa" TEXT,
    "condiciones_accion" TEXT,
    "estado" "estado_stop" NOT NULL DEFAULT 'abierto',
    "atendido_por" UUID,
    "atendido_at" TIMESTAMPTZ(6),
    "atendido_observacion" TEXT,
    "cerrado_por" UUID,
    "cerrado_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_by" UUID,
    CONSTRAINT "stop_tarjeta_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "stop_tarjeta_observador_fkey" FOREIGN KEY ("observador_id") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "stop_tarjeta_observado_fkey" FOREIGN KEY ("observado_id") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "stop_tarjeta_campo_fkey" FOREIGN KEY ("campo_id") REFERENCES catalogos.campo ("id"),
    CONSTRAINT "stop_tarjeta_operadora_fkey" FOREIGN KEY ("operadora_id") REFERENCES catalogos.cliente ("id"),
    CONSTRAINT "stop_tarjeta_ticket_fkey" FOREIGN KEY ("ticket_id") REFERENCES "ticket_ref" ("ticket_id"),
    CONSTRAINT "stop_tarjeta_foto_fkey" FOREIGN KEY ("foto_archivo_id") REFERENCES archivos.archivo ("id"),
    CONSTRAINT "stop_tarjeta_atendido_por_fkey" FOREIGN KEY ("atendido_por") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "stop_tarjeta_cerrado_por_fkey" FOREIGN KEY ("cerrado_por") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "stop_tarjeta_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "stop_tarjeta_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id"),
    -- el observador es quien registra y no se observa a sí mismo
    CONSTRAINT "stop_tarjeta_observado_check" CHECK ("observado_id" IS NULL OR "observado_id" <> "observador_id"),
    -- cada estado trae sus datos: lo que hizo QHSE (derivar o resolver) y, si se cerró, quién y cuándo
    CONSTRAINT "stop_tarjeta_estado_check" CHECK (
      ("estado" = 'abierto' AND "atendido_por" IS NULL AND "atendido_at" IS NULL AND "atendido_observacion" IS NULL AND "cerrado_por" IS NULL AND "cerrado_at" IS NULL)
      OR ("estado" IN ('derivado_mantenimiento', 'derivado_otro', 'resuelto_qhse')
          AND "atendido_por" IS NOT NULL AND "atendido_at" IS NOT NULL AND length(btrim(coalesce("atendido_observacion", ''))) > 0
          AND "cerrado_por" IS NULL AND "cerrado_at" IS NULL)
      OR ("estado" = 'cerrado'
          AND "atendido_por" IS NOT NULL AND "atendido_at" IS NOT NULL AND length(btrim(coalesce("atendido_observacion", ''))) > 0
          AND "cerrado_por" IS NOT NULL AND "cerrado_at" IS NOT NULL)));
CREATE INDEX "stop_tarjeta_estado_idx" ON "stop_tarjeta" ("estado");
CREATE INDEX "stop_tarjeta_fecha_idx" ON "stop_tarjeta" ("fecha");
CREATE INDEX "stop_tarjeta_observador_idx" ON "stop_tarjeta" ("observador_id");

-- Los ítems marcados (solo se guardan los que el observador marcó: seguro o inseguro).
CREATE TABLE "stop_tarjeta_item" (
    "tarjeta_id" UUID NOT NULL, "item_id" UUID NOT NULL, "estado" "estado_item_stop" NOT NULL,
    CONSTRAINT "stop_tarjeta_item_pkey" PRIMARY KEY ("tarjeta_id", "item_id"),
    CONSTRAINT "stop_tarjeta_item_tarjeta_fkey" FOREIGN KEY ("tarjeta_id") REFERENCES "stop_tarjeta" ("id") ON DELETE CASCADE,
    CONSTRAINT "stop_tarjeta_item_item_fkey" FOREIGN KEY ("item_id") REFERENCES "stop_item" ("id"));
CREATE INDEX "stop_tarjeta_item_item_idx" ON "stop_tarjeta_item" ("item_id");

CREATE TABLE "stop_historial" (
    "id" UUID NOT NULL, "tarjeta_id" UUID NOT NULL, "estado_anterior" "estado_stop", "estado_nuevo" "estado_stop" NOT NULL,
    "observacion" TEXT, "actor_id" UUID NOT NULL, "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "stop_historial_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "stop_historial_tarjeta_fkey" FOREIGN KEY ("tarjeta_id") REFERENCES "stop_tarjeta" ("id") ON DELETE CASCADE,
    CONSTRAINT "stop_historial_actor_fkey" FOREIGN KEY ("actor_id") REFERENCES identidad.usuario ("id"));
CREATE INDEX "stop_historial_tarjeta_idx" ON "stop_historial" ("tarjeta_id", "created_at");

-- Reglas del ciclo: abierto → (derivado a Mantenimiento | derivado a otro departamento | resuelto por QHSE); un derivado se cierra.
CREATE FUNCTION "stop_tarjeta_validar"() RETURNS trigger LANGUAGE plpgsql SET search_path = qhse, pg_catalog AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."estado" <> 'abierto' THEN RAISE EXCEPTION 'Una tarjeta STOP nace abierta' USING ERRCODE = 'check_violation'; END IF;
    RETURN NEW;
  END IF;
  IF NEW."estado" = OLD."estado" THEN RETURN NEW; END IF;
  IF OLD."estado" = 'abierto' AND NEW."estado" IN ('derivado_mantenimiento', 'derivado_otro', 'resuelto_qhse') THEN RETURN NEW; END IF;
  IF OLD."estado" IN ('derivado_mantenimiento', 'derivado_otro') AND NEW."estado" = 'cerrado' THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Cambio de estado no permitido: de % a %', OLD."estado", NEW."estado" USING ERRCODE = 'check_violation';
END
$$;
CREATE TRIGGER "stop_tarjeta_validar_trg" BEFORE INSERT OR UPDATE ON "stop_tarjeta" FOR EACH ROW EXECUTE FUNCTION "stop_tarjeta_validar"();

-- Una tarjeta trae al menos un ítem marcado (se comprueba al confirmar la transacción: la cabecera y sus ítems se crean juntos).
CREATE FUNCTION "stop_tarjeta_con_items"() RETURNS trigger LANGUAGE plpgsql SET search_path = qhse, pg_catalog AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "stop_tarjeta_item" WHERE "tarjeta_id" = NEW."id") THEN
    RAISE EXCEPTION 'La tarjeta STOP necesita al menos un ítem marcado' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER "stop_tarjeta_con_items_trg" AFTER INSERT ON "stop_tarjeta" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "stop_tarjeta_con_items"();

-- Lo observado no se reescribe: de la tarjeta solo cambian el estado y lo que QHSE hizo con ella; los ítems y el rastro no se editan ni se borran.
REVOKE UPDATE ON "stop_tarjeta" FROM app_qhse;
GRANT UPDATE ("estado", "atendido_por", "atendido_at", "atendido_observacion", "cerrado_por", "cerrado_at", "updated_at", "updated_by") ON "stop_tarjeta" TO app_qhse;
REVOKE DELETE ON "stop_tarjeta" FROM app_qhse;
REVOKE UPDATE, DELETE ON "stop_tarjeta_item" FROM app_qhse;
REVOKE UPDATE, DELETE ON "stop_historial" FROM app_qhse;

COMMENT ON TABLE "stop_tarjeta" IS 'Tarjeta de observación STOP (DYN-SGI-RE-008). Cualquier trabajador la registra; QHSE la deriva o resuelve y la cierra. Consecutivo STOP-000001.';
COMMENT ON COLUMN "stop_tarjeta"."observado_id" IS 'Persona observada; opcional (sin valor = anónimo o no indicado). No se guarda ningún texto «Anónimo».';
COMMENT ON COLUMN "stop_tarjeta"."lugar" IS 'Descripción libre del sitio exacto de la observación (el campo y la operadora van por sus catálogos).';
COMMENT ON COLUMN "stop_tarjeta"."contacto" IS 'Contacto del reportante en el formato físico (teléfono o correo escrito por quien llena la tarjeta).';
COMMENT ON TABLE "stop_tarjeta_item" IS 'Ítems del formato marcados como seguros o inseguros en la tarjeta. Inmutable.';

-- ---------------------------------------------------------------------------------------------------------------
-- Inspecciones de campo (eslinga de cable, detector de gas, vehículo-grúa)
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE "inspeccion_tipo" (
    "id" UUID NOT NULL, "codigo" TEXT NOT NULL, "nombre" TEXT NOT NULL, "orden" INTEGER NOT NULL,
    "frecuencia_dias" INTEGER NOT NULL,
    "requiere_bump_test" BOOLEAN NOT NULL DEFAULT false,
    "requiere_unidad" BOOLEAN NOT NULL DEFAULT false,
    "genera_caso_mantenimiento" BOOLEAN NOT NULL DEFAULT false,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_by" UUID,
    CONSTRAINT "inspeccion_tipo_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "inspeccion_tipo_codigo_key" UNIQUE ("codigo"),
    CONSTRAINT "inspeccion_tipo_orden_key" UNIQUE ("orden"),
    CONSTRAINT "inspeccion_tipo_frecuencia_check" CHECK ("frecuencia_dias" > 0),
    -- un caso de mantenimiento necesita saber de qué unidad se trata
    CONSTRAINT "inspeccion_tipo_caso_check" CHECK (NOT "genera_caso_mantenimiento" OR "requiere_unidad"),
    CONSTRAINT "inspeccion_tipo_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "inspeccion_tipo_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id"));
COMMENT ON COLUMN "inspeccion_tipo"."frecuencia_dias" IS 'Cada cuántos días se debe repetir la inspección (diaria = 1, trimestral = 90). El comportamiento nunca depende del nombre del tipo.';
COMMENT ON COLUMN "inspeccion_tipo"."requiere_unidad" IS 'La inspección es de una unidad de Flota (otro contenedor): exige el id de la unidad.';
COMMENT ON COLUMN "inspeccion_tipo"."genera_caso_mantenimiento" IS 'Una inspección rechazada de este tipo origina un reporte de unidad para Mantenimiento (evento qhse.reporte_unidad.generado).';

CREATE TABLE "inspeccion_criterio" (
    "id" UUID NOT NULL, "tipo_id" UUID NOT NULL, "nombre" TEXT NOT NULL, "orden" INTEGER NOT NULL, "activo" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_by" UUID,
    CONSTRAINT "inspeccion_criterio_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "inspeccion_criterio_orden_key" UNIQUE ("tipo_id", "orden"),
    CONSTRAINT "inspeccion_criterio_tipo_fkey" FOREIGN KEY ("tipo_id") REFERENCES "inspeccion_tipo" ("id"),
    CONSTRAINT "inspeccion_criterio_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "inspeccion_criterio_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id"));

CREATE TABLE "inspeccion" (
    "id" UUID NOT NULL,
    "numero" INTEGER GENERATED ALWAYS AS IDENTITY,
    "tipo_id" UUID NOT NULL,
    "equipo_codigo" TEXT NOT NULL,
    "unidad_id" UUID,
    "unidad_codigo" TEXT,
    "inspector_id" UUID NOT NULL,
    "fecha" DATE NOT NULL,
    "resultado" "resultado_inspeccion" NOT NULL,
    "bump_test_realizado" BOOLEAN,
    "vigente_hasta" DATE NOT NULL,
    "observaciones" TEXT,
    "ticket_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "created_by" UUID NOT NULL,
    CONSTRAINT "inspeccion_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "inspeccion_tipo_fkey" FOREIGN KEY ("tipo_id") REFERENCES "inspeccion_tipo" ("id"),
    CONSTRAINT "inspeccion_inspector_fkey" FOREIGN KEY ("inspector_id") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "inspeccion_ticket_fkey" FOREIGN KEY ("ticket_id") REFERENCES "ticket_ref" ("ticket_id"),
    CONSTRAINT "inspeccion_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "inspeccion_equipo_check" CHECK (length(btrim("equipo_codigo")) > 0),
    -- vigencia trimestral desde el día de la inspección
    CONSTRAINT "inspeccion_vigencia_check" CHECK ("vigente_hasta" = ("fecha" + INTERVAL '3 months')::date),
    CONSTRAINT "inspeccion_unidad_check" CHECK (("unidad_id" IS NULL) = ("unidad_codigo" IS NULL)));
CREATE INDEX "inspeccion_equipo_idx" ON "inspeccion" ("tipo_id", "equipo_codigo", "fecha" DESC);
CREATE INDEX "inspeccion_resultado_idx" ON "inspeccion" ("resultado");
COMMENT ON COLUMN "inspeccion"."equipo_codigo" IS 'Identificación física del equipo (n.º de la eslinga, serie del detector, código de la unidad). No hay un inventario de estos equipos: es el dato que escribe quien inspecciona.';
COMMENT ON COLUMN "inspeccion"."unidad_id" IS 'Id de la unidad en el contenedor operaciones (Flota). Sin FK: otro contenedor (D1). Solo los tipos que lo exigen (vehículo-grúa).';
COMMENT ON COLUMN "inspeccion"."unidad_codigo" IS 'COPIA justificada: código de la unidad de Flota, para mostrarlo en la bandeja y en el caso de Mantenimiento sin consultar otro contenedor. La unidad se identifica por unidad_id.';
COMMENT ON COLUMN "inspeccion"."vigente_hasta" IS 'Fecha de la inspección + 3 meses (vigencia trimestral, lo exige inspeccion_vigencia_check).';

CREATE TABLE "inspeccion_resultado" (
    "inspeccion_id" UUID NOT NULL, "criterio_id" UUID NOT NULL, "cumple" BOOLEAN NOT NULL,
    CONSTRAINT "inspeccion_resultado_pkey" PRIMARY KEY ("inspeccion_id", "criterio_id"),
    CONSTRAINT "inspeccion_resultado_inspeccion_fkey" FOREIGN KEY ("inspeccion_id") REFERENCES "inspeccion" ("id") ON DELETE CASCADE,
    CONSTRAINT "inspeccion_resultado_criterio_fkey" FOREIGN KEY ("criterio_id") REFERENCES "inspeccion_criterio" ("id"));

-- Reglas por tipo (columnas del tipo, no nombres): unidad si la exige, bump test si lo exige, y el criterio debe ser del tipo.
CREATE FUNCTION "inspeccion_validar"() RETURNS trigger LANGUAGE plpgsql SET search_path = qhse, pg_catalog AS $$
DECLARE v_tipo RECORD;
BEGIN
  SELECT "requiere_unidad", "requiere_bump_test", "activo" INTO v_tipo FROM "inspeccion_tipo" WHERE "id" = NEW."tipo_id";
  IF NOT v_tipo."activo" THEN RAISE EXCEPTION 'El tipo de inspección está inactivo' USING ERRCODE = 'check_violation'; END IF;
  IF v_tipo."requiere_unidad" AND NEW."unidad_id" IS NULL THEN
    RAISE EXCEPTION 'Este tipo de inspección es de una unidad: indique cuál' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT v_tipo."requiere_unidad" AND NEW."unidad_id" IS NOT NULL THEN
    RAISE EXCEPTION 'Este tipo de inspección no es de una unidad de Flota' USING ERRCODE = 'check_violation';
  END IF;
  IF v_tipo."requiere_bump_test" AND NEW."bump_test_realizado" IS NULL THEN
    RAISE EXCEPTION 'Indique si se hizo el bump test' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT v_tipo."requiere_bump_test" AND NEW."bump_test_realizado" IS NOT NULL THEN
    RAISE EXCEPTION 'Este tipo de inspección no lleva bump test' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "inspeccion_validar_trg" BEFORE INSERT ON "inspeccion" FOR EACH ROW EXECUTE FUNCTION "inspeccion_validar"();

CREATE FUNCTION "inspeccion_resultado_validar"() RETURNS trigger LANGUAGE plpgsql SET search_path = qhse, pg_catalog AS $$
BEGIN
  IF (SELECT c."tipo_id" FROM "inspeccion_criterio" c WHERE c."id" = NEW."criterio_id")
     IS DISTINCT FROM (SELECT i."tipo_id" FROM "inspeccion" i WHERE i."id" = NEW."inspeccion_id") THEN
    RAISE EXCEPTION 'El criterio no es del tipo de inspección' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "inspeccion_resultado_validar_trg" BEFORE INSERT ON "inspeccion_resultado" FOR EACH ROW EXECUTE FUNCTION "inspeccion_resultado_validar"();

-- El resultado se deduce de los criterios: rechazado si alguno falla; y se evalúan todos los criterios activos del tipo (al confirmar).
CREATE FUNCTION "inspeccion_coherente"() RETURNS trigger LANGUAGE plpgsql SET search_path = qhse, pg_catalog AS $$
DECLARE
  v_fallan INTEGER;
  v_faltan INTEGER;
BEGIN
  SELECT count(*) FILTER (WHERE NOT r."cumple") INTO v_fallan FROM "inspeccion_resultado" r WHERE r."inspeccion_id" = NEW."id";
  SELECT count(*) INTO v_faltan FROM "inspeccion_criterio" c
   WHERE c."tipo_id" = NEW."tipo_id" AND c."activo" AND NOT EXISTS (SELECT 1 FROM "inspeccion_resultado" r WHERE r."inspeccion_id" = NEW."id" AND r."criterio_id" = c."id");
  IF v_faltan > 0 THEN
    RAISE EXCEPTION 'Falta evaluar % criterio(s) de la inspección', v_faltan USING ERRCODE = 'check_violation';
  END IF;
  IF (v_fallan > 0) <> (NEW."resultado" = 'rechazado') THEN
    RAISE EXCEPTION 'El resultado no corresponde a los criterios: con algún criterio que falla la inspección se rechaza y si no, se aprueba' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER "inspeccion_coherente_trg" AFTER INSERT ON "inspeccion" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "inspeccion_coherente"();

-- Una inspección es historia: no se edita ni se borra (la cuarentena se levanta con una inspección nueva aprobada del mismo equipo).
REVOKE UPDATE, DELETE ON "inspeccion" FROM app_qhse;
REVOKE UPDATE, DELETE ON "inspeccion_resultado" FROM app_qhse;
COMMENT ON TABLE "inspeccion" IS 'Inspección de campo (eslinga de cable, detector de gas, vehículo-grúa). Inmutable. Un equipo está en cuarentena mientras su última inspección esté rechazada.';
