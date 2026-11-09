-- Revisión de reportes de llegada: el Supervisor del ticket aprueba o rechaza (con motivo) el reporte de unidad de llegada de cada unidad y día.
-- La inspección de llegada la aprueba Flota y llega por evento como hecho de la unidad y el día.
ALTER TYPE "pumping"."tipo_hecho_traslado" ADD VALUE IF NOT EXISTS 'inspeccion_llegada_realizada';
ALTER TYPE "pumping"."tipo_hecho_traslado" ADD VALUE IF NOT EXISTS 'inspeccion_llegada_aprobada';

CREATE TYPE "pumping"."decision_revision_reporte" AS ENUM ('aprobada', 'rechazada');

-- Historia de revisiones (solo se agrega): la vigente de cada unidad y día es la más reciente. Si el operador vuelve a firmar el reporte después
-- de un rechazo, el Supervisor lo revisa de nuevo.
CREATE TABLE "pumping"."reporte_llegada_revision" (
    "id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "unidad_id" UUID NOT NULL,
    "fecha" DATE NOT NULL,
    "decision" "pumping"."decision_revision_reporte" NOT NULL,
    "motivo" TEXT,
    "revisado_por" UUID NOT NULL,
    "revisado_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "reporte_llegada_revision_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "reporte_llegada_revision_ticket_fkey" FOREIGN KEY ("ticket_id") REFERENCES "pumping"."ticket" ("id") ON DELETE CASCADE,
    CONSTRAINT "reporte_llegada_revision_unidad_fkey" FOREIGN KEY ("unidad_id") REFERENCES "flota"."unidad" ("id"),
    CONSTRAINT "reporte_llegada_revision_revisado_por_fkey" FOREIGN KEY ("revisado_por") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "reporte_llegada_revision_motivo_check" CHECK ("decision" <> 'rechazada' OR length(btrim(coalesce("motivo", ''))) >= 3)
);
CREATE INDEX "reporte_llegada_revision_ticket_idx" ON "pumping"."reporte_llegada_revision" ("ticket_id", "unidad_id", "fecha", "revisado_at" DESC);
GRANT SELECT, INSERT ON "pumping"."reporte_llegada_revision" TO app_operaciones;
REVOKE UPDATE, DELETE, TRUNCATE ON "pumping"."reporte_llegada_revision" FROM app_operaciones;
COMMENT ON TABLE "pumping"."reporte_llegada_revision" IS 'Aprobaciones y rechazos del Supervisor al reporte de unidad de llegada de cada unidad y día. Solo se agrega.';
