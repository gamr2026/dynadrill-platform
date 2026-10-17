-- QHSE, revisión de base de datos del 17/10/2026 (ver plan-qhse.md, «Hallazgos»): catálogos de verdad en lugar de texto libre,
-- historia inmutable, renglones que no se pueden cambiar tras el despacho (lo garantiza la base), auditoría uniforme y
-- justificación de las copias y de los datos personales. No edita la migración ya aplicada: la corrige con esta.

-- Lectura mínima de `catalogos.bodega`: el lugar de la entrega es una base o bodega del catálogo.
GRANT USAGE ON SCHEMA catalogos TO app_qhse;
GRANT SELECT (id, nombre, habilitado) ON catalogos.bodega TO app_qhse;

-- Las columnas de texto libre que se reemplazan no pueden traer datos: no hay forma segura de convertirlas a un catálogo.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "epi_entrega_item" WHERE "talla" IS NOT NULL OR "codigo" IS NOT NULL)
     OR EXISTS (SELECT 1 FROM "epi_entrega" WHERE "lugar" IS NOT NULL) THEN
    RAISE EXCEPTION 'Hay entregas de EPI con lugar, talla o código en texto libre: conviértalas a mano antes de aplicar esta migración';
  END IF;
END
$$;

CREATE TYPE "tipo_talla" AS ENUM ('ropa', 'calzado', 'guante');

-- ---------------------------------------------------------------------------------------------------------------
-- Catálogo de elementos: código estable y tipo de talla (reemplaza el booleano `requiere_talla`) + auditoría
-- ---------------------------------------------------------------------------------------------------------------
-- Son filas de catálogo sembradas: las que ningún renglón usa se vuelven a sembrar con código (semilla); las usadas se conservan.
DELETE FROM "epi_elemento" e WHERE NOT EXISTS (SELECT 1 FROM "epi_entrega_item" i WHERE i."elemento_id" = e."id");
ALTER TABLE "epi_elemento" ADD COLUMN "codigo" TEXT, ADD COLUMN "tipo_talla" "tipo_talla";
UPDATE "epi_elemento" SET "codigo" = 'legado_' || "orden", "tipo_talla" = CASE WHEN "requiere_talla" THEN 'ropa'::"tipo_talla" END;
ALTER TABLE "epi_elemento" ALTER COLUMN "codigo" SET NOT NULL, DROP COLUMN "requiere_talla";
ALTER TABLE "epi_elemento"
  ADD COLUMN "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "created_by" UUID,
  ADD COLUMN "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "updated_by" UUID,
  ADD CONSTRAINT "epi_elemento_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
  ADD CONSTRAINT "epi_elemento_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id"),
  ADD CONSTRAINT "epi_elemento_codigo_check" CHECK ("codigo" ~ '^[a-z0-9_]+$');
CREATE UNIQUE INDEX "epi_elemento_codigo_key" ON "epi_elemento" ("codigo");

-- ---------------------------------------------------------------------------------------------------------------
-- Catálogo de tallas por tipo (ropa, calzado, guante)
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE "epi_talla" (
    "id" UUID NOT NULL,
    "tipo" "tipo_talla" NOT NULL,
    "codigo" TEXT NOT NULL,
    "orden" INTEGER NOT NULL,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    CONSTRAINT "epi_talla_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "epi_talla_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "epi_talla_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "epi_talla_codigo_check" CHECK (length(btrim("codigo")) > 0)
);
CREATE UNIQUE INDEX "epi_talla_tipo_codigo_key" ON "epi_talla" ("tipo", "codigo");
CREATE UNIQUE INDEX "epi_talla_tipo_orden_key" ON "epi_talla" ("tipo", "orden");

-- ---------------------------------------------------------------------------------------------------------------
-- Entrega: lugar = base o bodega del catálogo
-- ---------------------------------------------------------------------------------------------------------------
ALTER TABLE "epi_entrega" ADD COLUMN "lugar_bodega_id" UUID,
  ADD CONSTRAINT "epi_entrega_lugar_bodega_fkey" FOREIGN KEY ("lugar_bodega_id") REFERENCES catalogos.bodega ("id");
ALTER TABLE "epi_entrega" DROP COLUMN "lugar";
CREATE INDEX "epi_entrega_lugar_bodega_id_idx" ON "epi_entrega" ("lugar_bodega_id");

-- ---------------------------------------------------------------------------------------------------------------
-- Renglones: talla del catálogo, sin código libre (QHSE no es dueño de artículos; ver D16) + auditoría
-- ---------------------------------------------------------------------------------------------------------------
ALTER TABLE "epi_entrega_item" ADD COLUMN "talla_id" UUID,
  ADD CONSTRAINT "epi_entrega_item_talla_fkey" FOREIGN KEY ("talla_id") REFERENCES "epi_talla" ("id");
ALTER TABLE "epi_entrega_item" DROP COLUMN "talla", DROP COLUMN "codigo";
ALTER TABLE "epi_entrega_item"
  ADD COLUMN "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "created_by" UUID,
  ADD COLUMN "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "updated_by" UUID,
  ADD CONSTRAINT "epi_entrega_item_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
  ADD CONSTRAINT "epi_entrega_item_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id");

-- ---------------------------------------------------------------------------------------------------------------
-- Reglas que garantiza la base (no solo el servicio)
-- ---------------------------------------------------------------------------------------------------------------
-- 1) Los renglones solo cambian mientras la entrega está solicitada o aprobada, y la talla debe ser del tipo que lleva el elemento.
CREATE FUNCTION "epi_entrega_item_validar"() RETURNS trigger LANGUAGE plpgsql SET search_path = qhse, pg_catalog AS $$
DECLARE
  v_estado "estado_epi";
  v_lleva "tipo_talla";
  v_talla "tipo_talla";
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT "estado" INTO v_estado FROM qhse."epi_entrega" WHERE "id" = OLD."entrega_id";
    -- si la entrega ya no existe es un borrado en cascada (limpieza por el dueño del schema): se permite
    IF FOUND AND v_estado NOT IN ('solicitado', 'aprobado') THEN
      RAISE EXCEPTION 'Los renglones de una entrega % no se pueden cambiar', v_estado USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;

  SELECT "estado" INTO v_estado FROM qhse."epi_entrega" WHERE "id" = NEW."entrega_id";
  IF v_estado NOT IN ('solicitado', 'aprobado') THEN
    RAISE EXCEPTION 'Los renglones de una entrega % no se pueden cambiar', v_estado USING ERRCODE = 'check_violation';
  END IF;

  SELECT "tipo_talla" INTO v_lleva FROM qhse."epi_elemento" WHERE "id" = NEW."elemento_id";
  IF v_lleva IS NULL THEN
    IF NEW."talla_id" IS NOT NULL THEN
      RAISE EXCEPTION 'El elemento no lleva talla' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW."talla_id" IS NULL THEN
      RAISE EXCEPTION 'El elemento exige una talla de tipo %', v_lleva USING ERRCODE = 'check_violation';
    END IF;
    SELECT "tipo" INTO v_talla FROM qhse."epi_talla" WHERE "id" = NEW."talla_id";
    IF v_talla IS DISTINCT FROM v_lleva THEN
      RAISE EXCEPTION 'La talla no es del tipo que lleva el elemento (%)', v_lleva USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "epi_entrega_item_validar_trg" BEFORE INSERT OR UPDATE OR DELETE ON "epi_entrega_item"
  FOR EACH ROW EXECUTE FUNCTION "epi_entrega_item_validar"();

-- 2) Una entrega despachada es un registro firmado: solo puede completarse el «recibe conforme» de Talento Humano.
CREATE FUNCTION "epi_entrega_congelar"() RETURNS trigger LANGUAGE plpgsql SET search_path = qhse, pg_catalog AS $$
BEGIN
  IF (NEW."trabajador_id", NEW."ticket_id", NEW."lugar_bodega_id", NEW."firma_trabajador_por", NEW."firma_trabajador_at",
      NEW."aprobado_por", NEW."aprobado_at", NEW."despachado_por", NEW."despachado_at")
     IS DISTINCT FROM
     (OLD."trabajador_id", OLD."ticket_id", OLD."lugar_bodega_id", OLD."firma_trabajador_por", OLD."firma_trabajador_at",
      OLD."aprobado_por", OLD."aprobado_at", OLD."despachado_por", OLD."despachado_at") THEN
    RAISE EXCEPTION 'Una entrega despachada no se puede modificar (revierta el despacho con su motivo)' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "epi_entrega_congelar_trg" BEFORE UPDATE ON "epi_entrega"
  FOR EACH ROW WHEN (OLD."estado" = 'despachado' AND NEW."estado" = 'despachado')
  EXECUTE FUNCTION "epi_entrega_congelar"();

-- 3) Historia inmutable: ni UPDATE ni DELETE para la aplicación (el DELETE nunca se concedió; se deja explícito).
REVOKE UPDATE, DELETE ON "epi_entrega_historial" FROM app_qhse;

-- ---------------------------------------------------------------------------------------------------------------
-- Justificaciones (copias y datos personales)
-- ---------------------------------------------------------------------------------------------------------------
COMMENT ON TABLE "ticket_ref" IS 'Referencia local de un ticket de OTRO contenedor (operaciones): se llena por evento y se actualiza con cada evento posterior. Sin FK entre contenedores (D1).';
COMMENT ON COLUMN "ticket_ref"."ticket_id" IS 'Id del ticket en el contenedor operaciones. Sin FK: otro contenedor (D1); se valida porque solo existe si llegó su evento.';
COMMENT ON COLUMN "ticket_ref"."pedido_id" IS 'Id del pedido en el contenedor comercial. Sin FK: otro contenedor (D1).';
COMMENT ON COLUMN "ticket_ref"."ticket_numero" IS 'COPIA justificada: número del ticket que el usuario de QHSE necesita ver en bandejas y hojas; QHSE no puede obtenerlo con un JOIN. Se mantiene por evento (ticket_creado y asignacion_realizada).';
COMMENT ON COLUMN "ticket_ref"."pedido_codigo" IS 'COPIA justificada: código del pedido, por la misma razón que ticket_numero. Se mantiene por evento.';
COMMENT ON COLUMN "epi_entrega"."numero" IS 'Consecutivo interno de la entrega (referencia visible EPI-000001). El formato DYN-SGI-RE-032 no tiene numeración propia y no es un documento comercial, por eso no pasa por el motor de secuenciales de plataforma.';
COMMENT ON COLUMN "epi_entrega"."lugar_bodega_id" IS 'Base o bodega donde se entrega el EPI (catalogos.bodega); se exige para despachar.';
COMMENT ON COLUMN "epi_entrega"."trabajador_id" IS 'Quien recibe el EPI. Su cédula y cargo se leen del perfil (identidad.usuario_perfil, GRANT SELECT solo de cedula y cargo) porque el formato DYN-SGI-RE-032 imprime la cédula del trabajador; no se copian aquí.';
COMMENT ON COLUMN "epi_entrega_item"."talla_id" IS 'Talla del catálogo, del mismo tipo que el elemento (lo garantiza el trigger epi_entrega_item_validar).';
