-- QHSE, requisitos legales (DocumentoLegalQhse de la demo): las matrices de evaluación de requisitos legales de Gestión Ambiental y de Seguridad y Salud en
-- el Trabajo. La demo guardaba UN archivo por tipo y lo pisaba con cada revisión nueva; aquí cada revisión es una fila (la anterior queda como historia
-- inmutable) y se agrega la vigencia, que el brief pide para avisar de lo que está por vencer. El documento vive en el servicio de archivos.

CREATE TYPE "estado_requisito_legal" AS ENUM ('vigente', 'reemplazado');

CREATE TABLE "requisito_legal_tipo" (
    "id" UUID NOT NULL,
    "codigo" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "orden" INTEGER NOT NULL,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_by" UUID,
    CONSTRAINT "requisito_legal_tipo_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "requisito_legal_tipo_codigo_key" UNIQUE ("codigo"),
    CONSTRAINT "requisito_legal_tipo_orden_key" UNIQUE ("orden"),
    CONSTRAINT "requisito_legal_tipo_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "requisito_legal_tipo_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id"));
COMMENT ON TABLE "requisito_legal_tipo" IS 'Tipos de matriz de requisitos legales: Gestión Ambiental y Seguridad y Salud en el Trabajo.';

CREATE TABLE "requisito_legal" (
    "id" UUID NOT NULL,
    "tipo_id" UUID NOT NULL,
    "revision" TEXT NOT NULL,
    "fecha_aprobacion" DATE NOT NULL,
    "vigente_hasta" DATE,
    "archivo_id" UUID NOT NULL,
    "estado" "estado_requisito_legal" NOT NULL DEFAULT 'vigente',
    "reemplazado_at" TIMESTAMPTZ(6),
    "reemplazado_por" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_by" UUID,
    CONSTRAINT "requisito_legal_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "requisito_legal_tipo_fkey" FOREIGN KEY ("tipo_id") REFERENCES "requisito_legal_tipo" ("id"),
    CONSTRAINT "requisito_legal_archivo_fkey" FOREIGN KEY ("archivo_id") REFERENCES archivos.archivo ("id"),
    CONSTRAINT "requisito_legal_reemplazado_por_fkey" FOREIGN KEY ("reemplazado_por") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "requisito_legal_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "requisito_legal_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "requisito_legal_revision_key" UNIQUE ("tipo_id", "revision"),
    CONSTRAINT "requisito_legal_archivo_key" UNIQUE ("archivo_id"),
    CONSTRAINT "requisito_legal_revision_check" CHECK (length(btrim("revision")) > 0),
    CONSTRAINT "requisito_legal_vigencia_check" CHECK ("vigente_hasta" IS NULL OR "vigente_hasta" >= "fecha_aprobacion"),
    -- una revisión reemplazada dice cuándo y quién la reemplazó; una vigente no
    CONSTRAINT "requisito_legal_estado_check" CHECK (
      ("estado" = 'vigente' AND "reemplazado_at" IS NULL AND "reemplazado_por" IS NULL)
      OR ("estado" = 'reemplazado' AND "reemplazado_at" IS NOT NULL AND "reemplazado_por" IS NOT NULL)));
-- una sola revisión vigente por tipo
CREATE UNIQUE INDEX "requisito_legal_vigente_key" ON "requisito_legal" ("tipo_id") WHERE "estado" = 'vigente';
CREATE INDEX "requisito_legal_vence_idx" ON "requisito_legal" ("vigente_hasta") WHERE "estado" = 'vigente' AND "vigente_hasta" IS NOT NULL;

COMMENT ON TABLE "requisito_legal" IS 'Revisión de la matriz de requisitos legales de un tipo. Una sola vigente por tipo; al registrar una nueva, la anterior queda reemplazada (historia inmutable).';
COMMENT ON COLUMN "requisito_legal"."archivo_id" IS 'Documento en el servicio de archivos (módulo qhse_requisito_legal). FK a archivos.archivo (maestra compartida).';
COMMENT ON COLUMN "requisito_legal"."vigente_hasta" IS 'Hasta cuándo rige esta revisión. Opcional: la demo no tenía vigencia y no hay un plazo confirmado con Dynadrill, así que no se calcula; QHSE la indica si la matriz la tiene.';

-- Reglas: una revisión nace vigente y solo pasa de vigente a reemplazada; lo demás no se cambia.
CREATE FUNCTION "requisito_legal_validar"() RETURNS trigger LANGUAGE plpgsql SET search_path = qhse, pg_catalog AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."estado" <> 'vigente' THEN RAISE EXCEPTION 'Una revisión legal nace vigente' USING ERRCODE = 'check_violation'; END IF;
    RETURN NEW;
  END IF;
  IF NEW."tipo_id" <> OLD."tipo_id" OR NEW."revision" <> OLD."revision" OR NEW."fecha_aprobacion" <> OLD."fecha_aprobacion"
     OR NEW."vigente_hasta" IS DISTINCT FROM OLD."vigente_hasta" OR NEW."archivo_id" <> OLD."archivo_id" THEN
    RAISE EXCEPTION 'Una revisión legal registrada no se modifica: registre una revisión nueva' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."estado" = OLD."estado" THEN RETURN NEW; END IF;
  IF OLD."estado" = 'vigente' AND NEW."estado" = 'reemplazado' THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Cambio de estado no permitido: de % a %', OLD."estado", NEW."estado" USING ERRCODE = 'check_violation';
END
$$;
CREATE TRIGGER "requisito_legal_validar_trg" BEFORE INSERT OR UPDATE ON "requisito_legal" FOR EACH ROW EXECUTE FUNCTION "requisito_legal_validar"();

-- Privilegios mínimos: no se borra; solo cambian el estado y los datos del reemplazo.
REVOKE UPDATE ON "requisito_legal" FROM app_qhse;
GRANT UPDATE ("estado", "reemplazado_at", "reemplazado_por", "updated_at", "updated_by") ON "requisito_legal" TO app_qhse;
REVOKE DELETE ON "requisito_legal" FROM app_qhse;
