-- Revisión de los documentos por pedido: QHSE puede aprobar o rechazar (con motivo) un documento cargado. Hasta ahora un documento solo estaba cargado
-- o anulado. Un documento rechazado deja de valer igual que uno anulado (por eso el rechazo exige también la anulación: los índices únicos vigentes,
-- el trigger de «en uso por un PTW» y todas las consultas que miran `anulado_at` lo tratan como faltante y se puede cargar otro). Aprobar no cambia
-- nada de lo que ve Operaciones. Cada cambio queda en `documento_pedido_revision` (solo se agrega).
CREATE TYPE "qhse"."estado_revision_documento" AS ENUM ('cargado', 'aprobado', 'rechazado');
CREATE TYPE "qhse"."estado_historial_documento" AS ENUM ('cargado', 'aprobado', 'rechazado', 'anulado');

ALTER TABLE "qhse"."documento_pedido"
  ADD COLUMN "revision_estado" "qhse"."estado_revision_documento" NOT NULL DEFAULT 'cargado',
  ADD COLUMN "revisado_at" TIMESTAMPTZ(6),
  ADD COLUMN "revisado_por" UUID,
  ADD COLUMN "motivo_rechazo" TEXT;

ALTER TABLE "qhse"."documento_pedido"
  ADD CONSTRAINT "documento_pedido_revisado_por_fkey" FOREIGN KEY ("revisado_por") REFERENCES identidad.usuario ("id"),
  -- cargado: sin revisión; aprobado: quién y cuándo; rechazado: quién, cuándo y por qué (no vacío)
  ADD CONSTRAINT "documento_pedido_revision_check" CHECK (
    ("revision_estado" = 'cargado' AND "revisado_at" IS NULL AND "revisado_por" IS NULL AND "motivo_rechazo" IS NULL)
    OR ("revision_estado" = 'aprobado' AND "revisado_at" IS NOT NULL AND "revisado_por" IS NOT NULL AND "motivo_rechazo" IS NULL)
    OR ("revision_estado" = 'rechazado' AND "revisado_at" IS NOT NULL AND "revisado_por" IS NOT NULL AND length(btrim(coalesce("motivo_rechazo", ''))) > 0)),
  -- un documento rechazado está anulado (mismo efecto aguas abajo)
  ADD CONSTRAINT "documento_pedido_rechazo_anulado_check" CHECK ("revision_estado" <> 'rechazado' OR "anulado_at" IS NOT NULL);

GRANT UPDATE ("revision_estado", "revisado_at", "revisado_por", "motivo_rechazo") ON "qhse"."documento_pedido" TO app_qhse;

-- Solo un documento cargado y vigente se revisa, y una sola vez; la revisión no se edita.
CREATE FUNCTION "qhse"."documento_pedido_revision_validar"() RETURNS trigger LANGUAGE plpgsql SET search_path = qhse, pg_catalog AS $$
BEGIN
  IF NEW."revision_estado" IS DISTINCT FROM OLD."revision_estado" THEN
    IF OLD."revision_estado" <> 'cargado' THEN
      RAISE EXCEPTION 'El documento ya fue revisado (%) y no se puede revisar de nuevo', OLD."revision_estado" USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."anulado_at" IS NOT NULL THEN
      RAISE EXCEPTION 'El documento está anulado y no se puede revisar' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."revision_estado" = 'aprobado' AND NEW."anulado_at" IS NOT NULL THEN
      RAISE EXCEPTION 'No se puede aprobar un documento anulado' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF (NEW."revisado_at", NEW."revisado_por", NEW."motivo_rechazo") IS DISTINCT FROM (OLD."revisado_at", OLD."revisado_por", OLD."motivo_rechazo") THEN
    RAISE EXCEPTION 'La revisión del documento no se puede cambiar' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "documento_pedido_revision_validar_trg" BEFORE UPDATE ON "qhse"."documento_pedido"
  FOR EACH ROW EXECUTE FUNCTION "qhse"."documento_pedido_revision_validar"();

CREATE TABLE "qhse"."documento_pedido_revision" (
    "id" UUID NOT NULL,
    "documento_pedido_id" UUID NOT NULL,
    "estado_anterior" "qhse"."estado_historial_documento",
    "estado_nuevo" "qhse"."estado_historial_documento" NOT NULL,
    "motivo" TEXT,
    "actor_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "documento_pedido_revision_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "documento_pedido_revision_documento_fkey" FOREIGN KEY ("documento_pedido_id") REFERENCES "qhse"."documento_pedido" ("id") ON DELETE CASCADE,
    CONSTRAINT "documento_pedido_revision_actor_fkey" FOREIGN KEY ("actor_id") REFERENCES identidad.usuario ("id"),
    -- la carga es el primer paso (no hay estado anterior); rechazar y anular siempre llevan su motivo
    CONSTRAINT "documento_pedido_revision_carga_check" CHECK (("estado_nuevo" = 'cargado') = ("estado_anterior" IS NULL)),
    CONSTRAINT "documento_pedido_revision_motivo_check" CHECK (
      ("motivo" IS NULL OR length(btrim("motivo")) > 0)
      AND ("estado_nuevo" NOT IN ('rechazado', 'anulado') OR "motivo" IS NOT NULL))
);
CREATE INDEX "documento_pedido_revision_documento_idx" ON "qhse"."documento_pedido_revision" ("documento_pedido_id", "created_at");
CREATE INDEX "documento_pedido_revision_actor_idx" ON "qhse"."documento_pedido_revision" ("actor_id");

-- Historia ya existente: una fila por la carga y otra por la anulación (los documentos actuales quedan como «cargado»).
INSERT INTO "qhse"."documento_pedido_revision" ("id", "documento_pedido_id", "estado_anterior", "estado_nuevo", "motivo", "actor_id", "created_at")
SELECT gen_random_uuid(), "id", NULL, 'cargado', NULL, "created_by", "created_at" FROM "qhse"."documento_pedido";
INSERT INTO "qhse"."documento_pedido_revision" ("id", "documento_pedido_id", "estado_anterior", "estado_nuevo", "motivo", "actor_id", "created_at")
SELECT gen_random_uuid(), "id", 'cargado', 'anulado', "motivo_anulacion", "anulado_por", "anulado_at" FROM "qhse"."documento_pedido" WHERE "anulado_at" IS NOT NULL;

-- Historia inmutable: solo se lee y se agrega.
REVOKE ALL ON "qhse"."documento_pedido_revision" FROM app_qhse;
GRANT SELECT, INSERT ON "qhse"."documento_pedido_revision" TO app_qhse;

COMMENT ON TABLE "qhse"."documento_pedido_revision" IS 'Rastro de cada cambio de estado de un documento por pedido (cargado, aprobado, rechazado, anulado) con quién y por qué (solo se agrega).';
COMMENT ON COLUMN "qhse"."documento_pedido_revision"."estado_anterior" IS 'Estado antes del cambio; vacío en la carga.';
COMMENT ON COLUMN "qhse"."documento_pedido_revision"."motivo" IS 'Motivo del rechazo o de la anulación (obligatorio en ambos); opcional al aprobar.';
COMMENT ON COLUMN "qhse"."documento_pedido"."revision_estado" IS 'Revisión de QHSE: cargado (todavía sin revisar), aprobado o rechazado. Un rechazado también está anulado (deja de valer y se puede cargar otro).';
COMMENT ON COLUMN "qhse"."documento_pedido"."revisado_at" IS 'Cuándo se aprobó o rechazó el documento.';
COMMENT ON COLUMN "qhse"."documento_pedido"."revisado_por" IS 'Quién aprobó o rechazó el documento (identidad.usuario).';
COMMENT ON COLUMN "qhse"."documento_pedido"."motivo_rechazo" IS 'Por qué se rechazó el documento (obligatorio al rechazar).';
