-- QHSE: un PTW solo avanza si las matrices IPERC de las actividades que exige el tipo de servicio de su ticket están APROBADAS y VIGENTES el día
-- de operación (respuesta de Dynadrill, 18/10/2026). Las matrices usadas se fijan en `ptw_matriz` al validar la gabinete, igual que los
-- documentos; después quedan congeladas. La regla la garantiza la base (triggers), no solo el servicio.

CREATE TABLE "ptw_matriz" (
    "ptw_id" UUID NOT NULL,
    "matriz_id" UUID NOT NULL,
    CONSTRAINT "ptw_matriz_pkey" PRIMARY KEY ("ptw_id", "matriz_id"),
    CONSTRAINT "ptw_matriz_ptw_fkey" FOREIGN KEY ("ptw_id") REFERENCES "ptw" ("id") ON DELETE CASCADE,
    CONSTRAINT "ptw_matriz_matriz_fkey" FOREIGN KEY ("matriz_id") REFERENCES "iperc_matriz" ("id"));
CREATE INDEX "ptw_matriz_matriz_idx" ON "ptw_matriz" ("matriz_id");
REVOKE UPDATE, DELETE ON "ptw_matriz" FROM app_qhse;
COMMENT ON TABLE "ptw_matriz" IS 'Matrices IPERC aprobadas y vigentes que respaldan un PTW (una por actividad exigida por el tipo de servicio del ticket). Se fijan al validar la gabinete y no cambian.';

-- Una matriz solo se fija mientras el PTW está en gabinete; debe ser la aprobada de una actividad exigida y cubrir el día de operación.
CREATE FUNCTION "ptw_matriz_validar"() RETURNS trigger LANGUAGE plpgsql SET search_path = qhse, pg_catalog AS $$
DECLARE
  v_ptw RECORD;
  v_matriz RECORD;
BEGIN
  SELECT "fase", "anulado_at", "ticket_id", "dia_operacion" INTO v_ptw FROM "ptw" WHERE "id" = NEW."ptw_id";
  IF v_ptw."anulado_at" IS NOT NULL OR v_ptw."fase" <> 'gabinete' THEN
    RAISE EXCEPTION 'Las matrices IPERC se fijan con el PTW en gabinete' USING ERRCODE = 'check_violation';
  END IF;
  SELECT "estado", "actividad_id", "aprobada_el", "vigente_hasta" INTO v_matriz FROM "iperc_matriz" WHERE "id" = NEW."matriz_id";
  IF v_matriz."estado" <> 'aprobada' THEN
    RAISE EXCEPTION 'La matriz IPERC no está aprobada' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT (v_matriz."aprobada_el" <= v_ptw."dia_operacion" AND v_ptw."dia_operacion" <= v_matriz."vigente_hasta") THEN
    RAISE EXCEPTION 'La matriz IPERC no está vigente el día de operación del PTW (una matriz vencida bloquea)' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "iperc_cobertura" c JOIN "ticket_servicio" s ON s."tipo_codigo" = c."tipo_servicio_codigo"
                  WHERE s."ticket_id" = v_ptw."ticket_id" AND c."actividad_id" = v_matriz."actividad_id") THEN
    RAISE EXCEPTION 'La actividad de esa matriz no la exige el tipo de servicio del ticket' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "ptw_matriz_validar_trg" BEFORE INSERT ON "ptw_matriz" FOR EACH ROW EXECUTE FUNCTION "ptw_matriz_validar"();

-- ptw_validar: igual que antes, y al pasar de gabinete a formalización exige una matriz fijada por cada actividad que exige el ticket.
CREATE OR REPLACE FUNCTION "ptw_validar"() RETURNS trigger LANGUAGE plpgsql SET search_path = qhse, pg_catalog AS $$
DECLARE
  v_doc RECORD;
  v_firmas INTEGER;
  v_sin_matriz INTEGER;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."fase" <> 'gabinete' OR NEW."documento_recepcion_id" IS NOT NULL OR NEW."documento_art_id" IS NOT NULL
       OR NEW."documento_pt_id" IS NOT NULL OR NEW."documento_sfi_id" IS NOT NULL THEN
      RAISE EXCEPTION 'Un PTW nace en gabinete y sin documentos fijados' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF (NEW."ticket_id", NEW."pedido_id", NEW."dia_operacion") IS DISTINCT FROM (OLD."ticket_id", OLD."pedido_id", OLD."dia_operacion") THEN
    RAISE EXCEPTION 'El ticket, el pedido y el día de un PTW no se pueden cambiar (anúlelo y abra otro)' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."anulado_at" IS NOT NULL THEN
    RAISE EXCEPTION 'El PTW está anulado y no se puede cambiar' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."anulado_at" IS NOT NULL AND (NEW."fase", NEW."documento_recepcion_id", NEW."documento_art_id", NEW."documento_pt_id", NEW."documento_sfi_id")
       IS DISTINCT FROM (OLD."fase", OLD."documento_recepcion_id", OLD."documento_art_id", OLD."documento_pt_id", OLD."documento_sfi_id") THEN
    RAISE EXCEPTION 'Al anular un PTW no se cambia su fase ni sus documentos' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."anulado_at" IS NOT NULL THEN RETURN NEW; END IF;

  IF OLD."fase" <> 'gabinete' AND (NEW."documento_recepcion_id", NEW."documento_art_id", NEW."documento_pt_id", NEW."documento_sfi_id")
       IS DISTINCT FROM (OLD."documento_recepcion_id", OLD."documento_art_id", OLD."documento_pt_id", OLD."documento_sfi_id") THEN
    RAISE EXCEPTION 'Los documentos del PTW ya están fijados' USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."fase" = OLD."fase" THEN RETURN NEW; END IF;

  IF OLD."fase" = 'gabinete' AND NEW."fase" = 'formalizacion' THEN
    FOR v_doc IN
      SELECT t."tipo_esperado", d."id", d."tipo", d."pedido_id", d."anulado_at", d."fecha", d."vigente_hasta"
      FROM (VALUES ('formato_recepcion'::tipo_documento_pedido, NEW."documento_recepcion_id"),
                   ('art', NEW."documento_art_id"), ('pt', NEW."documento_pt_id"), ('sfi', NEW."documento_sfi_id")) AS t("tipo_esperado", "doc_id")
      LEFT JOIN "documento_pedido" d ON d."id" = t."doc_id"
    LOOP
      IF v_doc."id" IS NULL THEN
        RAISE EXCEPTION 'Falta el documento % para pasar a formalización', v_doc."tipo_esperado" USING ERRCODE = 'check_violation';
      END IF;
      IF v_doc."tipo" <> v_doc."tipo_esperado" OR v_doc."pedido_id" <> NEW."pedido_id" OR v_doc."anulado_at" IS NOT NULL THEN
        RAISE EXCEPTION 'El documento % no es del pedido, no es de ese tipo o está anulado', v_doc."tipo_esperado" USING ERRCODE = 'check_violation';
      END IF;
      IF v_doc."tipo" = 'art' AND NOT (v_doc."fecha" <= NEW."dia_operacion" AND NEW."dia_operacion" <= v_doc."vigente_hasta") THEN
        RAISE EXCEPTION 'El ART no está vigente el día de operación del PTW (un ART vencido bloquea)' USING ERRCODE = 'check_violation';
      END IF;
      IF v_doc."tipo" = 'pt' AND v_doc."fecha" <> NEW."dia_operacion" THEN
        RAISE EXCEPTION 'El PT no es del día de operación del PTW' USING ERRCODE = 'check_violation';
      END IF;
    END LOOP;

    -- una matriz IPERC aprobada y vigente por cada actividad que exigen los tipos de servicio del ticket
    SELECT count(DISTINCT c."actividad_id") INTO v_sin_matriz
      FROM "iperc_cobertura" c JOIN "ticket_servicio" s ON s."tipo_codigo" = c."tipo_servicio_codigo"
     WHERE s."ticket_id" = NEW."ticket_id"
       AND NOT EXISTS (SELECT 1 FROM "ptw_matriz" pm JOIN "iperc_matriz" m ON m."id" = pm."matriz_id"
                        WHERE pm."ptw_id" = NEW."id" AND m."actividad_id" = c."actividad_id");
    IF v_sin_matriz > 0 THEN
      RAISE EXCEPTION 'Falta la matriz IPERC aprobada y vigente de % actividad(es) que exige el tipo de servicio', v_sin_matriz USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."fase" = 'formalizacion' AND NEW."fase" = 'aprobacion' THEN
    SELECT count(*) INTO v_firmas FROM "ptw_firma" WHERE "ptw_id" = NEW."id" AND "tipo" IN ('ptw_en_sitio', 'acta_recibimiento', 'barricadas');
    IF v_firmas < 3 THEN
      RAISE EXCEPTION 'Para pasar a aprobación faltan el PTW firmado en sitio, el acta de recibimiento o las barricadas' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."fase" = 'aprobacion' AND NEW."fase" = 'aprobado' THEN
    IF NOT EXISTS (SELECT 1 FROM "ptw_firma" WHERE "ptw_id" = NEW."id" AND "tipo" = 'aprobacion') THEN
      RAISE EXCEPTION 'Falta la aprobación de QHSE' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Cambio de fase no permitido: de % a %', OLD."fase", NEW."fase" USING ERRCODE = 'check_violation';
END
$$;
