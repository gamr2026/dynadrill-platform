-- Documentos que se adjuntan a un ticket de Pumping. Hoy: el documento de mezcla de químicos, obligatorio cuando la asignación
-- incluye químicos. El archivo vive en `archivos.archivo` (FK real: mismo servidor); aquí solo se guarda qué documento es de qué ticket.
CREATE TYPE "tipo_documento_ticket" AS ENUM ('mezcla_quimica');

CREATE TABLE "ticket_documento" (
    "id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "tipo" "tipo_documento_ticket" NOT NULL,
    "archivo_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    CONSTRAINT "ticket_documento_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ticket_documento_ticket_fkey" FOREIGN KEY ("ticket_id") REFERENCES "ticket"("id") ON DELETE CASCADE,
    CONSTRAINT "ticket_documento_archivo_fkey" FOREIGN KEY ("archivo_id") REFERENCES archivos.archivo("id"),
    CONSTRAINT "ticket_documento_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario("id")
);
CREATE INDEX "ticket_documento_ticket_idx" ON "ticket_documento"("ticket_id", "tipo");
-- un archivo se adjunta una sola vez a un ticket
CREATE UNIQUE INDEX "ticket_documento_archivo_key" ON "ticket_documento"("ticket_id", "archivo_id");
-- los documentos son historia: una corrección se adjunta como un documento nuevo (el vigente es el último)
REVOKE UPDATE, DELETE ON "ticket_documento" FROM app_operaciones;
COMMENT ON TABLE "ticket_documento" IS 'Documentos de un ticket de Pumping (tipo + archivo de `archivos`). Inmutable: el vigente de cada tipo es el último.';

-- Solo se comprueba que el archivo existe (el resto lo administra archivos).
GRANT USAGE ON SCHEMA archivos TO app_operaciones;
GRANT SELECT (id) ON archivos.archivo TO app_operaciones;
