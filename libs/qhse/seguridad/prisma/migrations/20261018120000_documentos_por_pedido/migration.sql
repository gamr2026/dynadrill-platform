-- QHSE: documentos por pedido (formato de recepción, ART, PT, SFI y Acta de Entrega de Locación, DYN-PMP-RE-027). Contrato 4.11.
-- El archivo vive en `archivos.archivo` (FK real: mismo servidor). El pedido y el ticket son de otros contenedores (D1): el pedido es un
-- id sin FK; el ticket se enlaza con la referencia local `ticket_ref` (mismo schema) por una FK COMPUESTA (ticket, pedido), de modo que
-- un documento nunca queda atado a un ticket que pertenece a otro pedido.

-- La aplicación solo comprueba que el archivo existe; el resto lo administra el módulo de archivos.
GRANT USAGE ON SCHEMA archivos TO app_qhse;
GRANT SELECT (id) ON archivos.archivo TO app_qhse;

CREATE TYPE "tipo_documento_pedido" AS ENUM ('formato_recepcion', 'art', 'pt', 'sfi', 'formato_entrega');

-- Llave para la FK compuesta (el ticket ya es único; se agrega la pareja para poder referenciarla).
ALTER TABLE "ticket_ref" ADD CONSTRAINT "ticket_ref_ticket_pedido_key" UNIQUE ("ticket_id", "pedido_id");

CREATE TABLE "documento_pedido" (
    "id" UUID NOT NULL,
    "pedido_id" UUID NOT NULL,
    "ticket_id" UUID,
    "tipo" "tipo_documento_pedido" NOT NULL,
    "archivo_id" UUID NOT NULL,
    "referencia" TEXT,
    "fecha" DATE,
    "vigente_hasta" DATE,
    "anulado_at" TIMESTAMPTZ(6),
    "anulado_por" UUID,
    "motivo_anulacion" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    CONSTRAINT "documento_pedido_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "documento_pedido_archivo_fkey" FOREIGN KEY ("archivo_id") REFERENCES archivos.archivo ("id"),
    CONSTRAINT "documento_pedido_ticket_fkey" FOREIGN KEY ("ticket_id", "pedido_id") REFERENCES "ticket_ref" ("ticket_id", "pedido_id"),
    CONSTRAINT "documento_pedido_anulado_por_fkey" FOREIGN KEY ("anulado_por") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "documento_pedido_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "documento_pedido_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id"),
    -- el Acta de Entrega siempre pertenece a un ticket (es lo que cumple el requisito de cierre)
    CONSTRAINT "documento_pedido_acta_ticket_check" CHECK ("tipo" <> 'formato_entrega' OR "ticket_id" IS NOT NULL),
    -- ART: se emite un día y vale 15 días (vigencia legal); PT: es del día de operación; el resto no lleva fecha de vigencia
    CONSTRAINT "documento_pedido_art_check" CHECK ("tipo" <> 'art' OR ("fecha" IS NOT NULL AND "vigente_hasta" = "fecha" + 15)),
    CONSTRAINT "documento_pedido_pt_check" CHECK ("tipo" <> 'pt' OR "fecha" IS NOT NULL),
    CONSTRAINT "documento_pedido_vigencia_check" CHECK ("tipo" = 'art' OR "vigente_hasta" IS NULL),
    CONSTRAINT "documento_pedido_referencia_check" CHECK ("referencia" IS NULL OR length(btrim("referencia")) > 0),
    -- anular exige quién, cuándo y por qué, todo junto
    CONSTRAINT "documento_pedido_anulacion_check" CHECK (
      ("anulado_at" IS NULL AND "anulado_por" IS NULL AND "motivo_anulacion" IS NULL)
      OR ("anulado_at" IS NOT NULL AND "anulado_por" IS NOT NULL AND length(btrim(coalesce("motivo_anulacion", ''))) > 0))
);
CREATE INDEX "documento_pedido_pedido_idx" ON "documento_pedido" ("pedido_id", "tipo");
CREATE INDEX "documento_pedido_ticket_idx" ON "documento_pedido" ("ticket_id");
CREATE INDEX "documento_pedido_archivo_idx" ON "documento_pedido" ("archivo_id");
-- Una sola Acta vigente por pedido y un solo PT vigente por pedido y día (formato de recepción: uno por pedido).
CREATE UNIQUE INDEX "documento_pedido_acta_vigente_key" ON "documento_pedido" ("pedido_id")
  WHERE "tipo" = 'formato_entrega' AND "anulado_at" IS NULL;
CREATE UNIQUE INDEX "documento_pedido_recepcion_vigente_key" ON "documento_pedido" ("pedido_id")
  WHERE "tipo" = 'formato_recepcion' AND "anulado_at" IS NULL;
CREATE UNIQUE INDEX "documento_pedido_pt_dia_vigente_key" ON "documento_pedido" ("pedido_id", "fecha")
  WHERE "tipo" = 'pt' AND "anulado_at" IS NULL;

-- Historia inmutable: nunca se borra y lo cargado no se edita; solo se puede ANULAR (una vez) con quién, cuándo y por qué.
-- Se garantiza con privilegios por columna (la aplicación ni siquiera puede escribir las demás columnas).
REVOKE UPDATE ON "documento_pedido" FROM app_qhse;
GRANT UPDATE ("anulado_at", "anulado_por", "motivo_anulacion", "updated_at", "updated_by") ON "documento_pedido" TO app_qhse;
REVOKE DELETE ON "documento_pedido" FROM app_qhse;

CREATE FUNCTION "documento_pedido_una_anulacion"() RETURNS trigger LANGUAGE plpgsql SET search_path = qhse, pg_catalog AS $$
BEGIN
  IF OLD."anulado_at" IS NOT NULL THEN
    RAISE EXCEPTION 'El documento ya está anulado y no se puede cambiar' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "documento_pedido_una_anulacion_trg" BEFORE UPDATE ON "documento_pedido"
  FOR EACH ROW EXECUTE FUNCTION "documento_pedido_una_anulacion"();

COMMENT ON TABLE "documento_pedido" IS 'Documentos de seguridad de un pedido (formato de recepción, ART, PT, SFI, Acta de Entrega de Locación). Historia: solo se anulan, no se editan ni se borran.';
COMMENT ON COLUMN "documento_pedido"."pedido_id" IS 'Id del pedido en el contenedor comercial. Sin FK: otro contenedor (D1); solo se acepta un pedido que QHSE conoce por los tickets que le llegaron por evento.';
COMMENT ON COLUMN "documento_pedido"."ticket_id" IS 'Ticket (referencia local ticket_ref, FK compuesta con el pedido). Obligatorio en el Acta de Entrega; opcional en los demás documentos, que son del pedido.';
COMMENT ON COLUMN "documento_pedido"."referencia" IS 'Número impreso en el documento físico (p. ej. el del ART). Dato del documento, no una copia de otra tabla.';
COMMENT ON COLUMN "documento_pedido"."fecha" IS 'ART: día de emisión. PT: día de operación al que corresponde. Los demás no la usan.';
COMMENT ON COLUMN "documento_pedido"."vigente_hasta" IS 'Solo el ART: emisión + 15 días (vigencia legal). Lo calcula el servicio y lo exige el CHECK documento_pedido_art_check.';
