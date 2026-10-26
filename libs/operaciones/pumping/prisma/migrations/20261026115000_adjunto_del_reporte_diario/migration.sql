-- D-PD (PLAN-CIERRE-MODELADO.md): el Reporte Diario de Pumping conserva el adjunto de la demo (el archivo del reporte, por ejemplo la plantilla
-- DYN-SGI-RE-047 llenada). El archivo vive en `archivos.archivo` (FK real, mismo servidor); aquí solo se guarda de qué reporte es. Las firmas del
-- supervisor y del cliente NO se guardan aquí: se registran en `plataforma/firmas` (evento operaciones.pumping.reporte_diario.firmado).
CREATE TABLE "reporte_diario_adjunto" (
    "id" UUID NOT NULL,
    "reporte_id" UUID NOT NULL,
    "archivo_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    CONSTRAINT "reporte_diario_adjunto_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "reporte_diario_adjunto_reporte_fkey" FOREIGN KEY ("reporte_id") REFERENCES "reporte_diario"("id") ON DELETE CASCADE,
    CONSTRAINT "reporte_diario_adjunto_archivo_fkey" FOREIGN KEY ("archivo_id") REFERENCES archivos.archivo("id"),
    CONSTRAINT "reporte_diario_adjunto_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario("id")
);
-- un archivo se adjunta una sola vez a un reporte
CREATE UNIQUE INDEX "reporte_diario_adjunto_key" ON "reporte_diario_adjunto"("reporte_id", "archivo_id");
CREATE INDEX "reporte_diario_adjunto_archivo_idx" ON "reporte_diario_adjunto"("archivo_id");
-- los adjuntos son historia: una corrección se adjunta como un archivo nuevo
REVOKE UPDATE, DELETE ON "reporte_diario_adjunto" FROM app_operaciones;
COMMENT ON TABLE "reporte_diario_adjunto" IS 'Archivos adjuntos a un día del Reporte Diario de Pumping (archivo de `archivos`). Inmutable.';
