-- QHSE: Permiso de Trabajo (PTW, HSE-SITIO-001). Uno por día de operación y pedido, abierto desde un ticket. Fases: gabinete (se reúnen
-- los documentos: formato de recepción, ART vigente ese día, PT del día y SFI) → formalización (PTW firmado en sitio, acta de recibimiento
-- y barricadas) → aprobación (la hace QHSE) → aprobado. Las reglas de las fases las garantiza la base, no solo el servicio.
-- El pedido y el ticket son de otros contenedores (D1): el pedido es un id sin FK y el ticket se enlaza con `ticket_ref` por FK compuesta.
-- El vínculo con el IPERC aprobado se agrega cuando exista el IPERC (tramo Q3): hoy la matriz es maestra y no bloquea la apertura.

CREATE TYPE "fase_ptw" AS ENUM ('gabinete', 'formalizacion', 'aprobacion', 'aprobado');
CREATE TYPE "tipo_firma_ptw" AS ENUM ('ptw_en_sitio', 'acta_recibimiento', 'barricadas', 'aprobacion');
CREATE TYPE "accion_ptw" AS ENUM ('abierto', 'documentos_validados', 'firmado', 'aprobado', 'anulado');

CREATE TABLE "ptw" (
    "id" UUID NOT NULL,
    "numero" INTEGER GENERATED ALWAYS AS IDENTITY,
    "ticket_id" UUID NOT NULL,
    "pedido_id" UUID NOT NULL,
    "dia_operacion" DATE NOT NULL,
    "fase" "fase_ptw" NOT NULL DEFAULT 'gabinete',
    "documento_recepcion_id" UUID,
    "documento_art_id" UUID,
    "documento_pt_id" UUID,
    "documento_sfi_id" UUID,
    "anulado_at" TIMESTAMPTZ(6),
    "anulado_por" UUID,
    "motivo_anulacion" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    CONSTRAINT "ptw_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ptw_ticket_fkey" FOREIGN KEY ("ticket_id", "pedido_id") REFERENCES "ticket_ref" ("ticket_id", "pedido_id"),
    CONSTRAINT "ptw_doc_recepcion_fkey" FOREIGN KEY ("documento_recepcion_id") REFERENCES "documento_pedido" ("id"),
    CONSTRAINT "ptw_doc_art_fkey" FOREIGN KEY ("documento_art_id") REFERENCES "documento_pedido" ("id"),
    CONSTRAINT "ptw_doc_pt_fkey" FOREIGN KEY ("documento_pt_id") REFERENCES "documento_pedido" ("id"),
    CONSTRAINT "ptw_doc_sfi_fkey" FOREIGN KEY ("documento_sfi_id") REFERENCES "documento_pedido" ("id"),
    CONSTRAINT "ptw_anulado_por_fkey" FOREIGN KEY ("anulado_por") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "ptw_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "ptw_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id"),
    -- pasada la gabinete, los cuatro documentos están fijados
    CONSTRAINT "ptw_documentos_check" CHECK (
      "fase" = 'gabinete'
      OR ("documento_recepcion_id" IS NOT NULL AND "documento_art_id" IS NOT NULL AND "documento_pt_id" IS NOT NULL AND "documento_sfi_id" IS NOT NULL)),
    CONSTRAINT "ptw_anulacion_check" CHECK (
      ("anulado_at" IS NULL AND "anulado_por" IS NULL AND "motivo_anulacion" IS NULL)
      OR ("anulado_at" IS NOT NULL AND "anulado_por" IS NOT NULL AND length(btrim(coalesce("motivo_anulacion", ''))) > 0))
);
CREATE INDEX "ptw_ticket_idx" ON "ptw" ("ticket_id");
CREATE INDEX "ptw_pedido_dia_idx" ON "ptw" ("pedido_id", "dia_operacion");
CREATE INDEX "ptw_fase_idx" ON "ptw" ("fase");
-- Un PTW vigente por pedido y día de operación (regla de Dynadrill, 18/10/2026).
CREATE UNIQUE INDEX "ptw_pedido_dia_vigente_key" ON "ptw" ("pedido_id", "dia_operacion") WHERE "anulado_at" IS NULL;

-- Confirmaciones «de una línea» (usuario + hora del servidor) mientras no exista la plataforma de Firmas (D6): después se migran allí.
CREATE TABLE "ptw_firma" (
    "id" UUID NOT NULL,
    "ptw_id" UUID NOT NULL,
    "tipo" "tipo_firma_ptw" NOT NULL,
    "usuario_id" UUID NOT NULL,
    "firmado_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ptw_firma_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ptw_firma_ptw_fkey" FOREIGN KEY ("ptw_id") REFERENCES "ptw" ("id") ON DELETE CASCADE,
    CONSTRAINT "ptw_firma_usuario_fkey" FOREIGN KEY ("usuario_id") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "ptw_firma_unica_key" UNIQUE ("ptw_id", "tipo")
);

CREATE TABLE "ptw_historial" (
    "id" UUID NOT NULL,
    "ptw_id" UUID NOT NULL,
    "accion" "accion_ptw" NOT NULL,
    "motivo" TEXT,
    "actor_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ptw_historial_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ptw_historial_ptw_fkey" FOREIGN KEY ("ptw_id") REFERENCES "ptw" ("id") ON DELETE CASCADE,
    CONSTRAINT "ptw_historial_actor_fkey" FOREIGN KEY ("actor_id") REFERENCES identidad.usuario ("id")
);
CREATE INDEX "ptw_historial_ptw_idx" ON "ptw_historial" ("ptw_id", "created_at");

-- ---------------------------------------------------------------------------------------------------------------
-- Reglas de las fases
-- ---------------------------------------------------------------------------------------------------------------
CREATE FUNCTION "ptw_validar"() RETURNS trigger LANGUAGE plpgsql SET search_path = qhse, pg_catalog AS $$
DECLARE
  v_doc RECORD;
  v_firmas INTEGER;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."fase" <> 'gabinete' OR NEW."documento_recepcion_id" IS NOT NULL OR NEW."documento_art_id" IS NOT NULL
       OR NEW."documento_pt_id" IS NOT NULL OR NEW."documento_sfi_id" IS NOT NULL THEN
      RAISE EXCEPTION 'Un PTW nace en gabinete y sin documentos fijados' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- el ticket, el pedido y el día no se cambian: si se abrió mal, se anula y se abre otro
  IF (NEW."ticket_id", NEW."pedido_id", NEW."dia_operacion") IS DISTINCT FROM (OLD."ticket_id", OLD."pedido_id", OLD."dia_operacion") THEN
    RAISE EXCEPTION 'El ticket, el pedido y el día de un PTW no se pueden cambiar (anúlelo y abra otro)' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."anulado_at" IS NOT NULL THEN
    RAISE EXCEPTION 'El PTW está anulado y no se puede cambiar' USING ERRCODE = 'check_violation';
  END IF;
  -- anular no mueve la fase ni los documentos
  IF NEW."anulado_at" IS NOT NULL AND (NEW."fase", NEW."documento_recepcion_id", NEW."documento_art_id", NEW."documento_pt_id", NEW."documento_sfi_id")
       IS DISTINCT FROM (OLD."fase", OLD."documento_recepcion_id", OLD."documento_art_id", OLD."documento_pt_id", OLD."documento_sfi_id") THEN
    RAISE EXCEPTION 'Al anular un PTW no se cambia su fase ni sus documentos' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."anulado_at" IS NOT NULL THEN RETURN NEW; END IF;

  -- los documentos solo se fijan al pasar de gabinete a formalización y después quedan congelados
  IF OLD."fase" <> 'gabinete' AND (NEW."documento_recepcion_id", NEW."documento_art_id", NEW."documento_pt_id", NEW."documento_sfi_id")
       IS DISTINCT FROM (OLD."documento_recepcion_id", OLD."documento_art_id", OLD."documento_pt_id", OLD."documento_sfi_id") THEN
    RAISE EXCEPTION 'Los documentos del PTW ya están fijados' USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."fase" = OLD."fase" THEN RETURN NEW; END IF;

  IF OLD."fase" = 'gabinete' AND NEW."fase" = 'formalizacion' THEN
    -- cada documento debe ser del tipo y del pedido, estar vigente (no anulado) y, el ART, cubrir el día de operación; el PT, ser de ese día
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
CREATE TRIGGER "ptw_validar_trg" BEFORE INSERT OR UPDATE ON "ptw" FOR EACH ROW EXECUTE FUNCTION "ptw_validar"();

-- Una confirmación solo se registra en la fase que le corresponde y en un PTW vigente.
CREATE FUNCTION "ptw_firma_validar"() RETURNS trigger LANGUAGE plpgsql SET search_path = qhse, pg_catalog AS $$
DECLARE v_ptw RECORD;
BEGIN
  SELECT "fase", "anulado_at" INTO v_ptw FROM "ptw" WHERE "id" = NEW."ptw_id";
  IF v_ptw."anulado_at" IS NOT NULL THEN
    RAISE EXCEPTION 'El PTW está anulado' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."tipo" IN ('ptw_en_sitio', 'acta_recibimiento', 'barricadas') AND v_ptw."fase" <> 'formalizacion' THEN
    RAISE EXCEPTION 'Esta confirmación se registra en la fase de formalización (el PTW está en %)', v_ptw."fase" USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."tipo" = 'aprobacion' AND v_ptw."fase" <> 'aprobacion' THEN
    RAISE EXCEPTION 'La aprobación se registra en la fase de aprobación (el PTW está en %)', v_ptw."fase" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "ptw_firma_validar_trg" BEFORE INSERT ON "ptw_firma" FOR EACH ROW EXECUTE FUNCTION "ptw_firma_validar"();

-- Un documento en uso por un PTW vigente no se puede anular: primero se anula el PTW (si no, el PTW quedaría apoyado en un papel inválido).
CREATE FUNCTION "documento_pedido_en_uso"() RETURNS trigger LANGUAGE plpgsql SET search_path = qhse, pg_catalog AS $$
DECLARE v_numero INTEGER;
BEGIN
  IF OLD."anulado_at" IS NULL AND NEW."anulado_at" IS NOT NULL THEN
    SELECT "numero" INTO v_numero FROM "ptw"
     WHERE "anulado_at" IS NULL AND NEW."id" IN ("documento_recepcion_id", "documento_art_id", "documento_pt_id", "documento_sfi_id")
     LIMIT 1;
    IF v_numero IS NOT NULL THEN
      RAISE EXCEPTION 'El documento está en uso por el PTW %; anule primero ese PTW', v_numero USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "documento_pedido_en_uso_trg" BEFORE UPDATE ON "documento_pedido" FOR EACH ROW EXECUTE FUNCTION "documento_pedido_en_uso"();

-- ---------------------------------------------------------------------------------------------------------------
-- Privilegios: la historia no se edita ni se borra; del PTW solo cambian la fase, los documentos, la anulación y la auditoría
-- ---------------------------------------------------------------------------------------------------------------
REVOKE UPDATE ON "ptw" FROM app_qhse;
GRANT UPDATE ("fase", "documento_recepcion_id", "documento_art_id", "documento_pt_id", "documento_sfi_id", "anulado_at", "anulado_por",
              "motivo_anulacion", "updated_at", "updated_by") ON "ptw" TO app_qhse;
REVOKE DELETE ON "ptw" FROM app_qhse;
REVOKE UPDATE, DELETE ON "ptw_firma" FROM app_qhse;
REVOKE UPDATE, DELETE ON "ptw_historial" FROM app_qhse;

COMMENT ON TABLE "ptw" IS 'Permiso de Trabajo (HSE-SITIO-001): uno vigente por pedido y día de operación. Fases gabinete → formalización → aprobación → aprobado, garantizadas por el trigger ptw_validar.';
COMMENT ON COLUMN "ptw"."numero" IS 'Consecutivo interno visible (PTW-000001). El formato no tiene numeración propia y no es un documento comercial: no pasa por el motor de secuenciales de plataforma.';
COMMENT ON COLUMN "ptw"."pedido_id" IS 'Id del pedido en el contenedor comercial. Sin FK: otro contenedor (D1); se valida por la FK compuesta (ticket, pedido) a ticket_ref.';
COMMENT ON COLUMN "ptw"."dia_operacion" IS 'Día de operación al que corresponde el PTW; el ART debe cubrirlo y el PT debe ser de ese día.';
COMMENT ON COLUMN "ptw"."documento_art_id" IS 'ART vigente el día de operación (un ART vencido bloquea el paso a formalización). Se fija una sola vez, al validar la gabinete.';
COMMENT ON TABLE "ptw_firma" IS 'Confirmaciones de una línea (usuario + hora del servidor) del PTW; migrarán a la plataforma de Firmas (D6). Inmutable.';
COMMENT ON TABLE "ptw_historial" IS 'Rastro de cada acción sobre un PTW (abrir, validar documentos, firmar, aprobar, anular). Solo se agrega.';
