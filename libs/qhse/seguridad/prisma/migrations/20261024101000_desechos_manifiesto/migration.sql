-- QHSE, tramo Q4: Desechos, manifiesto único con tres firmas (guía de remisión DYN-SGI-RE-063). El manifiesto lleva el número, el gestor y su
-- licencia SUIA, el cliente y el transporte (que en la demo se capturaban al registrar). Las tres firmas son las del formato: «despachado
-- por», «transportado por» y «recibido por». Cada firma es «de una línea» (D6): quien tiene la sesión la registra con la hora del servidor;
-- cuando firma en papel una persona sin cuenta (el conductor o el gestor) se guardan además su nombre y su cédula. La evidencia es el
-- documento firmado que se sube después (con la lectura de firma de plataforma): llega en la migración siguiente.

CREATE TYPE "rol_firma_desecho" AS ENUM ('despachado_por', 'transportado_por', 'recibido_por');

-- Del cliente de la guía solo se lee el RUC o identificación (dato de empresa) además del nombre comercial que ya se lee.
GRANT SELECT (identificacion) ON catalogos.cliente TO app_qhse;

CREATE TABLE "desecho_manifiesto" (
    "id" UUID NOT NULL,
    "desecho_id" UUID NOT NULL,
    "numero" TEXT NOT NULL,
    "fecha" DATE NOT NULL,
    "gestor_nombre" TEXT NOT NULL,
    "gestor_licencia_suia" TEXT NOT NULL,
    "cliente_id" UUID,
    "solicitado_por" TEXT,
    "transportista_compania" TEXT,
    "conductor_nombre" TEXT,
    "conductor_cedula" TEXT,
    "vehiculo" TEXT,
    "placas" TEXT,
    "hora_salida" TIMESTAMPTZ(6),
    "hora_llegada" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    CONSTRAINT "desecho_manifiesto_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "desecho_manifiesto_desecho_key" UNIQUE ("desecho_id"),
    CONSTRAINT "desecho_manifiesto_numero_key" UNIQUE ("numero"),
    CONSTRAINT "desecho_manifiesto_desecho_fkey" FOREIGN KEY ("desecho_id") REFERENCES "desecho" ("id") ON DELETE CASCADE,
    CONSTRAINT "desecho_manifiesto_cliente_fkey" FOREIGN KEY ("cliente_id") REFERENCES catalogos.cliente ("id"),
    CONSTRAINT "desecho_manifiesto_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "desecho_manifiesto_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "desecho_manifiesto_numero_check" CHECK (length(btrim("numero")) > 0),
    CONSTRAINT "desecho_manifiesto_gestor_check" CHECK (length(btrim("gestor_nombre")) > 0 AND length(btrim("gestor_licencia_suia")) > 0),
    CONSTRAINT "desecho_manifiesto_horas_check" CHECK ("hora_salida" IS NULL OR "hora_llegada" IS NULL OR "hora_llegada" >= "hora_salida")
);
CREATE INDEX "desecho_manifiesto_cliente_idx" ON "desecho_manifiesto" ("cliente_id") WHERE "cliente_id" IS NOT NULL;

CREATE TABLE "desecho_firma" (
    "id" UUID NOT NULL,
    "manifiesto_id" UUID NOT NULL,
    "rol" "rol_firma_desecho" NOT NULL,
    "registrado_por" UUID NOT NULL,
    "firmado_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "firmante_nombre" TEXT,
    "firmante_cedula" TEXT,
    CONSTRAINT "desecho_firma_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "desecho_firma_unica_key" UNIQUE ("manifiesto_id", "rol"),
    CONSTRAINT "desecho_firma_manifiesto_fkey" FOREIGN KEY ("manifiesto_id") REFERENCES "desecho_manifiesto" ("id") ON DELETE CASCADE,
    CONSTRAINT "desecho_firma_registrado_por_fkey" FOREIGN KEY ("registrado_por") REFERENCES identidad.usuario ("id"),
    -- «despachado por» es quien tiene la sesión (personal de Dynadrill); el conductor y el gestor firman en papel y se identifican
    CONSTRAINT "desecho_firma_firmante_check" CHECK (
      ("rol" = 'despachado_por' AND "firmante_nombre" IS NULL AND "firmante_cedula" IS NULL)
      OR ("rol" <> 'despachado_por' AND length(btrim("firmante_nombre")) > 0 AND length(btrim("firmante_cedula")) > 0))
);

-- Ciclo: almacenado → con_manifiesto (exige el manifiesto) → dispuesto (exige las tres firmas; el certificado lo exige la migración
-- siguiente). Un desecho dispuesto ya no se modifica.
CREATE OR REPLACE FUNCTION "desecho_validar"() RETURNS trigger LANGUAGE plpgsql SET search_path = qhse, pg_catalog AS $$
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
  IF v_antes = 'almacenado' AND v_ahora = 'con_manifiesto' THEN
    IF NOT EXISTS (SELECT 1 FROM "desecho_manifiesto" WHERE "desecho_id" = NEW."id") THEN
      RAISE EXCEPTION 'Para pasar a con manifiesto hay que generar el manifiesto' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF v_antes = 'con_manifiesto' AND v_ahora = 'dispuesto' THEN
    IF (SELECT count(*) FROM "desecho_firma" f JOIN "desecho_manifiesto" m ON m."id" = f."manifiesto_id" WHERE m."desecho_id" = NEW."id") < 3 THEN
      RAISE EXCEPTION 'Para disponer el desecho el manifiesto necesita las tres firmas' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Cambio de estado no permitido: de % a %', v_antes, v_ahora USING ERRCODE = 'check_violation';
END
$$;

-- El manifiesto se genera con el desecho almacenado; su transporte y sus horas se completan mientras falten firmas.
CREATE FUNCTION "desecho_manifiesto_validar"() RETURNS trigger LANGUAGE plpgsql SET search_path = qhse, pg_catalog AS $$
DECLARE
  v_estado TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT e."codigo" INTO v_estado FROM "desecho" d JOIN "desecho_estado" e ON e."id" = d."estado_id" WHERE d."id" = NEW."desecho_id";
    IF v_estado <> 'almacenado' THEN
      RAISE EXCEPTION 'El manifiesto se genera con el desecho almacenado (está %)', v_estado USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF (SELECT count(*) FROM "desecho_firma" WHERE "manifiesto_id" = OLD."id") >= 3 THEN
    RAISE EXCEPTION 'El manifiesto ya tiene las tres firmas y no se modifica' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "desecho_manifiesto_validar_trg" BEFORE INSERT OR UPDATE ON "desecho_manifiesto" FOR EACH ROW EXECUTE FUNCTION "desecho_manifiesto_validar"();

-- Solo se firma un manifiesto de un desecho con manifiesto (no dispuesto).
CREATE FUNCTION "desecho_firma_validar"() RETURNS trigger LANGUAGE plpgsql SET search_path = qhse, pg_catalog AS $$
DECLARE
  v_estado TEXT;
BEGIN
  SELECT e."codigo" INTO v_estado FROM "desecho_manifiesto" m JOIN "desecho" d ON d."id" = m."desecho_id"
    JOIN "desecho_estado" e ON e."id" = d."estado_id" WHERE m."id" = NEW."manifiesto_id";
  IF v_estado <> 'con_manifiesto' THEN
    RAISE EXCEPTION 'Las firmas se registran con el desecho en estado con manifiesto (está %)', v_estado USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "desecho_firma_validar_trg" BEFORE INSERT ON "desecho_firma" FOR EACH ROW EXECUTE FUNCTION "desecho_firma_validar"();

-- Privilegios: del manifiesto solo se completa el transporte y las horas; las firmas no se editan ni se borran ----------
REVOKE UPDATE ON "desecho_manifiesto" FROM app_qhse;
GRANT UPDATE ("cliente_id", "solicitado_por", "transportista_compania", "conductor_nombre", "conductor_cedula", "vehiculo", "placas",
              "hora_salida", "hora_llegada", "updated_at", "updated_by") ON "desecho_manifiesto" TO app_qhse;
REVOKE DELETE ON "desecho_manifiesto" FROM app_qhse;
REVOKE UPDATE, DELETE ON "desecho_firma" FROM app_qhse;

COMMENT ON TABLE "desecho_manifiesto" IS 'Manifiesto único / guía de remisión de desechos (DYN-SGI-RE-063): uno por desecho. Genera el paso a con_manifiesto; el certificado de disposición se pide dentro de 30 días de su fecha.';
COMMENT ON COLUMN "desecho_manifiesto"."gestor_licencia_suia" IS 'Licencia ambiental vigente del gestor (SUIA). Obligatoria para generar el manifiesto.';
COMMENT ON COLUMN "desecho_manifiesto"."cliente_id" IS 'Cliente de la guía (catalogos.cliente); su RUC se lee de allí, no se copia.';
COMMENT ON COLUMN "desecho_manifiesto"."conductor_cedula" IS 'Cédula del conductor del transportista externo, tal como la imprime la guía; es un tercero sin cuenta en el portal.';
COMMENT ON TABLE "desecho_firma" IS 'Firmas del manifiesto («de una línea», D6). Inmutable. registrado_por es quien tiene la sesión; firmante_nombre y firmante_cedula identifican a quien firma en papel cuando no tiene cuenta (transportista y gestor).';
