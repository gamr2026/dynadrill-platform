-- QHSE, tramo Q4: Desechos, documentos firmados y certificado de disposición final. Se carga el manifiesto firmado a mano (evidencia de las tres
-- firmas) y el certificado que emite el gestor ambiental. Al cargar cada documento se lee la firma con el OCR de plataforma (D6) y se guarda solo
-- el resultado como indicador: no certifica nada y nunca bloquea la carga. El certificado cierra el ciclo: el desecho pasa a dispuesto.
-- El plazo de 30 días desde el manifiesto no bloquea (el gestor puede tardar): se informa si el certificado llegó fuera de plazo.

CREATE TYPE "tipo_documento_desecho" AS ENUM ('manifiesto_firmado', 'certificado_disposicion');

CREATE TABLE "desecho_documento" (
    "id" UUID NOT NULL,
    "desecho_id" UUID NOT NULL,
    "tipo" "tipo_documento_desecho" NOT NULL,
    "archivo_id" UUID NOT NULL,
    "emitido_el" DATE,
    "referencia" TEXT,
    "verificacion" "verificacion_firma" NOT NULL DEFAULT 'no_verificada',
    "verificacion_confianza" DECIMAL(4,3),
    "verificacion_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    CONSTRAINT "desecho_documento_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "desecho_documento_unico_key" UNIQUE ("desecho_id", "tipo"),
    CONSTRAINT "desecho_documento_archivo_key" UNIQUE ("archivo_id"),
    CONSTRAINT "desecho_documento_desecho_fkey" FOREIGN KEY ("desecho_id") REFERENCES "desecho" ("id") ON DELETE CASCADE,
    CONSTRAINT "desecho_documento_archivo_fkey" FOREIGN KEY ("archivo_id") REFERENCES archivos.archivo ("id"),
    CONSTRAINT "desecho_documento_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "desecho_documento_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id"),
    -- la fecha de emisión es del certificado y solo del certificado
    CONSTRAINT "desecho_documento_emision_check" CHECK (("tipo" = 'certificado_disposicion') = ("emitido_el" IS NOT NULL)),
    CONSTRAINT "desecho_documento_confianza_check" CHECK ("verificacion_confianza" IS NULL OR ("verificacion_confianza" >= 0 AND "verificacion_confianza" <= 1))
);

-- Se cargan con el desecho con manifiesto y sus tres firmas; el certificado no puede ser anterior al manifiesto.
CREATE FUNCTION "desecho_documento_validar"() RETURNS trigger LANGUAGE plpgsql SET search_path = qhse, pg_catalog AS $$
DECLARE
  v_estado TEXT;
  v_fecha DATE;
BEGIN
  SELECT e."codigo", m."fecha" INTO v_estado, v_fecha
    FROM "desecho" d JOIN "desecho_estado" e ON e."id" = d."estado_id" LEFT JOIN "desecho_manifiesto" m ON m."desecho_id" = d."id"
   WHERE d."id" = NEW."desecho_id";
  IF v_estado <> 'con_manifiesto' THEN
    RAISE EXCEPTION 'Los documentos se cargan con el desecho en estado con manifiesto (está %)', v_estado USING ERRCODE = 'check_violation';
  END IF;
  IF (SELECT count(*) FROM "desecho_firma" f JOIN "desecho_manifiesto" m ON m."id" = f."manifiesto_id" WHERE m."desecho_id" = NEW."desecho_id") < 3 THEN
    RAISE EXCEPTION 'Los documentos se cargan cuando el manifiesto tiene las tres firmas' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."tipo" = 'certificado_disposicion' AND NEW."emitido_el" < v_fecha THEN
    RAISE EXCEPTION 'El certificado no puede ser anterior al manifiesto (%)', v_fecha USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "desecho_documento_validar_trg" BEFORE INSERT ON "desecho_documento" FOR EACH ROW EXECUTE FUNCTION "desecho_documento_validar"();

-- Ciclo: almacenado → con_manifiesto (exige el manifiesto) → dispuesto (exige las tres firmas y el certificado de disposición final).
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
    IF NOT EXISTS (SELECT 1 FROM "desecho_documento" WHERE "desecho_id" = NEW."id" AND "tipo" = 'certificado_disposicion') THEN
      RAISE EXCEPTION 'Para disponer el desecho hay que cargar el certificado de disposición final' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Cambio de estado no permitido: de % a %', v_antes, v_ahora USING ERRCODE = 'check_violation';
END
$$;

-- Un documento cargado no se reemplaza ni se borra; solo se actualiza el indicador de la lectura de firma.
REVOKE UPDATE ON "desecho_documento" FROM app_qhse;
GRANT UPDATE ("verificacion", "verificacion_confianza", "verificacion_at") ON "desecho_documento" TO app_qhse;
REVOKE DELETE ON "desecho_documento" FROM app_qhse;

COMMENT ON TABLE "desecho_documento" IS 'Manifiesto firmado y certificado de disposición final de un desecho (uno de cada tipo). El archivo lo guarda el módulo de archivos (qhse_desecho_documento).';
COMMENT ON COLUMN "desecho_documento"."emitido_el" IS 'Fecha de emisión del certificado (la que dice el documento del gestor). Solo para el certificado.';
COMMENT ON COLUMN "desecho_documento"."verificacion" IS 'Lectura automática de la firma (D6): solo un indicador para revisar, nunca bloquea la carga ni certifica autenticidad.';
