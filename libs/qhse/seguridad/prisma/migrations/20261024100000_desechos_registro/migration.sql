-- QHSE, tramo Q4: Desechos (HSE-AMBIENTAL-001, DYN-SGI-RE-063, AM 142). Esta migración trae el registro del desecho (peligroso o no, con sus
-- características CRETIB, el contenedor por color y las líneas de la guía) y el historial de estados. El manifiesto con tres firmas y el
-- certificado de disposición final llegan en migraciones siguientes. Los catálogos son tablas; el estado también (el comportamiento sale del
-- código estable, nunca del nombre).

CREATE TYPE "clasificacion_desecho" AS ENUM ('peligroso', 'no_peligroso');

-- Catálogos ------------------------------------------------------------------------------------------------------
CREATE TABLE "desecho_caracteristica" (
    "id" UUID NOT NULL,
    "codigo" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "orden" INTEGER NOT NULL,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    CONSTRAINT "desecho_caracteristica_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "desecho_caracteristica_codigo_key" UNIQUE ("codigo"),
    CONSTRAINT "desecho_caracteristica_orden_key" UNIQUE ("orden"),
    CONSTRAINT "desecho_caracteristica_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "desecho_caracteristica_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id")
);

CREATE TABLE "desecho_contenedor" (
    "id" UUID NOT NULL,
    "codigo" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "uso" TEXT NOT NULL,
    "orden" INTEGER NOT NULL,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    CONSTRAINT "desecho_contenedor_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "desecho_contenedor_codigo_key" UNIQUE ("codigo"),
    CONSTRAINT "desecho_contenedor_orden_key" UNIQUE ("orden"),
    CONSTRAINT "desecho_contenedor_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "desecho_contenedor_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id")
);

CREATE TABLE "desecho_estado" (
    "id" UUID NOT NULL,
    "codigo" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "orden" INTEGER NOT NULL,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    CONSTRAINT "desecho_estado_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "desecho_estado_codigo_key" UNIQUE ("codigo"),
    CONSTRAINT "desecho_estado_orden_key" UNIQUE ("orden"),
    CONSTRAINT "desecho_estado_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "desecho_estado_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id")
);

-- El pozo donde se generó el desecho (solo lo que se necesita para mostrarlo).
GRANT SELECT (id, codigo, nombre_completo, habilitado) ON catalogos.pozo TO app_qhse;

-- El desecho ------------------------------------------------------------------------------------------------------
CREATE TABLE "desecho" (
    "id" UUID NOT NULL,
    "numero" INTEGER GENERATED ALWAYS AS IDENTITY,
    "clasificacion" "clasificacion_desecho" NOT NULL,
    "contenedor_id" UUID NOT NULL,
    "estado_id" UUID NOT NULL,
    "descripcion" TEXT NOT NULL,
    "pozo_id" UUID,
    "ubicacion" TEXT,
    "registrado_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "registrado_el" DATE NOT NULL,
    "limite_almacenamiento_hasta" DATE NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    CONSTRAINT "desecho_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "desecho_numero_key" UNIQUE ("numero"),
    CONSTRAINT "desecho_contenedor_fkey" FOREIGN KEY ("contenedor_id") REFERENCES "desecho_contenedor" ("id"),
    CONSTRAINT "desecho_estado_fkey" FOREIGN KEY ("estado_id") REFERENCES "desecho_estado" ("id"),
    CONSTRAINT "desecho_pozo_fkey" FOREIGN KEY ("pozo_id") REFERENCES catalogos.pozo ("id"),
    CONSTRAINT "desecho_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "desecho_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "desecho_descripcion_check" CHECK (length(btrim("descripcion")) > 0),
    -- AM 142: máximo 12 meses de almacenamiento, contados desde el día del registro
    CONSTRAINT "desecho_limite_check" CHECK ("limite_almacenamiento_hasta" = ("registrado_el" + INTERVAL '12 months')::date)
);
CREATE INDEX "desecho_estado_idx" ON "desecho" ("estado_id");
CREATE INDEX "desecho_limite_idx" ON "desecho" ("limite_almacenamiento_hasta");
CREATE INDEX "desecho_contenedor_idx" ON "desecho" ("contenedor_id");
CREATE INDEX "desecho_pozo_idx" ON "desecho" ("pozo_id") WHERE "pozo_id" IS NOT NULL;

-- Características CRETIB del desecho peligroso (tabla puente).
CREATE TABLE "desecho_caracteristica_asignada" (
    "desecho_id" UUID NOT NULL,
    "caracteristica_id" UUID NOT NULL,
    CONSTRAINT "desecho_caracteristica_asignada_pkey" PRIMARY KEY ("desecho_id", "caracteristica_id"),
    CONSTRAINT "desecho_caracteristica_asignada_desecho_fkey" FOREIGN KEY ("desecho_id") REFERENCES "desecho" ("id") ON DELETE CASCADE,
    CONSTRAINT "desecho_caracteristica_asignada_car_fkey" FOREIGN KEY ("caracteristica_id") REFERENCES "desecho_caracteristica" ("id")
);
CREATE INDEX "desecho_caracteristica_asignada_car_idx" ON "desecho_caracteristica_asignada" ("caracteristica_id");

-- Líneas de la guía (columnas del formato DYN-SGI-RE-063).
CREATE TABLE "desecho_item" (
    "id" UUID NOT NULL,
    "desecho_id" UUID NOT NULL,
    "orden" INTEGER NOT NULL,
    "descripcion" TEXT NOT NULL,
    "numero_lote" TEXT,
    "codigo" TEXT NOT NULL,
    "cantidad_galones" NUMERIC(12,3) NOT NULL,
    "bultos" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    CONSTRAINT "desecho_item_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "desecho_item_orden_key" UNIQUE ("desecho_id", "orden"),
    CONSTRAINT "desecho_item_desecho_fkey" FOREIGN KEY ("desecho_id") REFERENCES "desecho" ("id") ON DELETE CASCADE,
    CONSTRAINT "desecho_item_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "desecho_item_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "desecho_item_descripcion_check" CHECK (length(btrim("descripcion")) > 0),
    CONSTRAINT "desecho_item_codigo_check" CHECK (length(btrim("codigo")) > 0),
    CONSTRAINT "desecho_item_cantidad_check" CHECK ("cantidad_galones" > 0),
    CONSTRAINT "desecho_item_bultos_check" CHECK ("bultos" >= 0),
    CONSTRAINT "desecho_item_orden_check" CHECK ("orden" > 0)
);

CREATE TABLE "desecho_historial" (
    "id" UUID NOT NULL,
    "desecho_id" UUID NOT NULL,
    "estado_anterior_id" UUID,
    "estado_nuevo_id" UUID NOT NULL,
    "actor_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "desecho_historial_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "desecho_historial_desecho_fkey" FOREIGN KEY ("desecho_id") REFERENCES "desecho" ("id") ON DELETE CASCADE,
    CONSTRAINT "desecho_historial_anterior_fkey" FOREIGN KEY ("estado_anterior_id") REFERENCES "desecho_estado" ("id"),
    CONSTRAINT "desecho_historial_nuevo_fkey" FOREIGN KEY ("estado_nuevo_id") REFERENCES "desecho_estado" ("id"),
    CONSTRAINT "desecho_historial_actor_fkey" FOREIGN KEY ("actor_id") REFERENCES identidad.usuario ("id")
);
CREATE INDEX "desecho_historial_desecho_idx" ON "desecho_historial" ("desecho_id", "created_at");

-- Reglas ------------------------------------------------------------------------------------------------------------
-- Ciclo: almacenado → con_manifiesto → dispuesto. Un desecho dispuesto ya no cambia. (Las migraciones del manifiesto y del certificado
-- reemplazan esta función para exigir sus requisitos.)
CREATE FUNCTION "desecho_validar"() RETURNS trigger LANGUAGE plpgsql SET search_path = qhse, pg_catalog AS $$
DECLARE
  v_antes TEXT;
  v_ahora TEXT;
BEGIN
  SELECT "codigo" INTO v_ahora FROM "desecho_estado" WHERE "id" = NEW."estado_id";
  IF TG_OP = 'INSERT' THEN
    IF v_ahora <> 'almacenado' THEN
      RAISE EXCEPTION 'Un desecho nace almacenado' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  SELECT "codigo" INTO v_antes FROM "desecho_estado" WHERE "id" = OLD."estado_id";
  IF v_antes = 'dispuesto' THEN
    RAISE EXCEPTION 'Un desecho dispuesto ya no se modifica' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."estado_id" = OLD."estado_id" THEN RETURN NEW; END IF;
  IF (v_antes = 'almacenado' AND v_ahora = 'con_manifiesto') OR (v_antes = 'con_manifiesto' AND v_ahora = 'dispuesto') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Cambio de estado no permitido: de % a %', v_antes, v_ahora USING ERRCODE = 'check_violation';
END
$$;
CREATE TRIGGER "desecho_validar_trg" BEFORE INSERT OR UPDATE ON "desecho" FOR EACH ROW EXECUTE FUNCTION "desecho_validar"();

-- Un peligroso lleva al menos una característica CRETIB; un no peligroso, ninguna; y la guía trae al menos una línea. Se comprueba al
-- confirmar la transacción (el desecho, sus características y sus líneas se crean juntos).
CREATE FUNCTION "desecho_completo"() RETURNS trigger LANGUAGE plpgsql SET search_path = qhse, pg_catalog AS $$
DECLARE
  v_car INTEGER;
BEGIN
  SELECT count(*) INTO v_car FROM "desecho_caracteristica_asignada" WHERE "desecho_id" = NEW."id";
  IF NEW."clasificacion" = 'peligroso' AND v_car = 0 THEN
    RAISE EXCEPTION 'Un desecho peligroso necesita al menos una característica CRETIB' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."clasificacion" = 'no_peligroso' AND v_car > 0 THEN
    RAISE EXCEPTION 'Un desecho no peligroso no lleva características CRETIB' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "desecho_item" WHERE "desecho_id" = NEW."id") THEN
    RAISE EXCEPTION 'La guía del desecho necesita al menos una línea' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER "desecho_completo_trg" AFTER INSERT ON "desecho" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "desecho_completo"();

-- Las características y las líneas solo se agregan mientras el desecho está almacenado.
CREATE FUNCTION "desecho_hijo_validar"() RETURNS trigger LANGUAGE plpgsql SET search_path = qhse, pg_catalog AS $$
DECLARE
  v_estado TEXT;
BEGIN
  SELECT e."codigo" INTO v_estado FROM "desecho" d JOIN "desecho_estado" e ON e."id" = d."estado_id" WHERE d."id" = NEW."desecho_id";
  IF v_estado <> 'almacenado' THEN
    RAISE EXCEPTION 'La guía y las características solo se completan con el desecho almacenado (está %)', v_estado USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "desecho_item_validar_trg" BEFORE INSERT ON "desecho_item" FOR EACH ROW EXECUTE FUNCTION "desecho_hijo_validar"();
CREATE TRIGGER "desecho_caracteristica_validar_trg" BEFORE INSERT ON "desecho_caracteristica_asignada" FOR EACH ROW EXECUTE FUNCTION "desecho_hijo_validar"();

-- Privilegios: lo registrado no se reescribe; solo avanza el estado -------------------------------------------------
REVOKE UPDATE ON "desecho" FROM app_qhse;
GRANT UPDATE ("estado_id", "updated_at", "updated_by") ON "desecho" TO app_qhse;
REVOKE DELETE ON "desecho" FROM app_qhse;
REVOKE UPDATE, DELETE ON "desecho_caracteristica_asignada" FROM app_qhse;
REVOKE UPDATE, DELETE ON "desecho_item" FROM app_qhse;
REVOKE UPDATE, DELETE ON "desecho_historial" FROM app_qhse;

COMMENT ON TABLE "desecho" IS 'Desecho generado en operación (HSE-AMBIENTAL-001). Consecutivo DES-000001. Ciclo almacenado → con_manifiesto → dispuesto.';
COMMENT ON COLUMN "desecho"."registrado_el" IS 'Día (hora de Ecuador) en que se registró; de aquí corre el límite de almacenamiento.';
COMMENT ON COLUMN "desecho"."limite_almacenamiento_hasta" IS 'AM 142: registro + 12 meses (lo exige desecho_limite_check). Pasada esta fecha sin disponer, el desecho está vencido.';
COMMENT ON COLUMN "desecho"."pozo_id" IS 'Pozo del catálogo donde se generó; si la ubicación no es un pozo (laydown, bodega, vía), se describe en `ubicacion`.';
COMMENT ON COLUMN "desecho"."created_by" IS 'Quien generó y registró el desecho (siempre quien tiene la sesión).';
COMMENT ON TABLE "desecho_contenedor" IS 'Código de color del contenedor: convención interna de Dynadrill, no una norma citada en HSE-AMBIENTAL-001.';
COMMENT ON TABLE "desecho_caracteristica" IS 'Características CRETIB: corrosivo, reactivo, explosivo, tóxico, inflamable, biológico-infeccioso.';
COMMENT ON TABLE "desecho_estado" IS 'Estados del ciclo. Los triggers deciden por `codigo`, nunca por el nombre.';
COMMENT ON TABLE "desecho_item" IS 'Líneas de la guía de remisión (DESCRIPCIÓN, LOTE, CÓDIGO DEL DESECHO, CANTIDAD EN GLNS, BULTOS). Solo se agregan al registrar.';
COMMENT ON TABLE "desecho_historial" IS 'Rastro de cada cambio de estado. Solo se agrega.';
