-- Flota, tramo F2: documentos con vigencia de los conductores (licencia, manejo defensivo, exámenes, vacunas...).
-- El conductor es una cuenta de `identidad.usuario` (no hay tabla de conductores aparte: sería repetir la cuenta). Cada documento
-- renovado es un registro nuevo (historia inmutable); el vigente de cada tipo es el último no anulado. Mientras algún documento
-- esté vencido o falte, la inspección de vehículos del conductor no se puede guardar (DYN-SGI-RE-068).

-- Catálogo de documentos que se exigen. `con_vigencia = false` es un documento que solo se tiene o no se tiene (p. ej. el permiso
-- de los clientes); los demás vencen en una fecha.
CREATE TABLE "tipo_permiso_conductor" (
    "id" UUID NOT NULL,
    "codigo" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "con_vigencia" BOOLEAN NOT NULL,
    "orden" SMALLINT NOT NULL,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    CONSTRAINT "tipo_permiso_conductor_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "tipo_permiso_conductor_codigo_key" ON "tipo_permiso_conductor"("codigo");
-- Apoya la FK compuesta de `conductor_permiso`: el tipo de documento decide si lleva fecha, y lo garantiza la base.
CREATE UNIQUE INDEX "tipo_permiso_conductor_id_con_vigencia_key" ON "tipo_permiso_conductor"("id", "con_vigencia");
ALTER TABLE "tipo_permiso_conductor"
  ADD CONSTRAINT "tipo_permiso_conductor_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
  ADD CONSTRAINT "tipo_permiso_conductor_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id");

CREATE TABLE "conductor_permiso" (
    "id" UUID NOT NULL,
    "usuario_id" UUID NOT NULL,
    "tipo_id" UUID NOT NULL,
    "con_vigencia" BOOLEAN NOT NULL,
    "vigente_hasta" DATE,
    "archivo_id" UUID,
    "observaciones" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    CONSTRAINT "conductor_permiso_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "conductor_permiso_vigencia_check" CHECK ("con_vigencia" = ("vigente_hasta" IS NOT NULL))
);
CREATE INDEX "conductor_permiso_usuario_id_tipo_id_created_at_idx" ON "conductor_permiso"("usuario_id", "tipo_id", "created_at" DESC);
ALTER TABLE "conductor_permiso"
  ADD CONSTRAINT "conductor_permiso_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES identidad.usuario ("id"),
  ADD CONSTRAINT "conductor_permiso_tipo_fkey" FOREIGN KEY ("tipo_id", "con_vigencia") REFERENCES "tipo_permiso_conductor" ("id", "con_vigencia"),
  ADD CONSTRAINT "conductor_permiso_archivo_id_fkey" FOREIGN KEY ("archivo_id") REFERENCES archivos.archivo ("id"),
  ADD CONSTRAINT "conductor_permiso_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id");

CREATE TABLE "conductor_permiso_anulacion" (
    "permiso_id" UUID NOT NULL,
    "anulada_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "anulada_por" UUID NOT NULL,
    "motivo" TEXT NOT NULL,
    CONSTRAINT "conductor_permiso_anulacion_pkey" PRIMARY KEY ("permiso_id"),
    CONSTRAINT "conductor_permiso_anulacion_motivo_check" CHECK (char_length(btrim("motivo")) >= 5)
);
ALTER TABLE "conductor_permiso_anulacion"
  ADD CONSTRAINT "conductor_permiso_anulacion_permiso_id_fkey" FOREIGN KEY ("permiso_id") REFERENCES "conductor_permiso" ("id") ON DELETE CASCADE,
  ADD CONSTRAINT "conductor_permiso_anulacion_anulada_por_fkey" FOREIGN KEY ("anulada_por") REFERENCES identidad.usuario ("id");

-- Historia inmutable: un documento mal cargado se anula (con motivo) y se registra el correcto.
REVOKE UPDATE, DELETE ON "conductor_permiso", "conductor_permiso_anulacion" FROM app_operaciones;

COMMENT ON TABLE "conductor_permiso" IS 'Un documento del conductor por registro; el vigente es el último no anulado de cada tipo. La cuenta (usuario_id) es el conductor.';
COMMENT ON COLUMN "conductor_permiso"."con_vigencia" IS 'Copia del tipo, garantizada por la FK compuesta con tipo_permiso_conductor(id, con_vigencia): sirve solo para que la base exija la fecha cuando el documento vence.';
COMMENT ON COLUMN "conductor_permiso"."vigente_hasta" IS 'Último día de validez; nulo solo en los documentos sin vigencia (tipo.con_vigencia = false).';
