-- Operadores asignados a cada ticket de Pumping (cuenta de identidad, FK real). Los fija el evento `asignacion_realizada` y reemplazan a los
-- anteriores. Con ellos el endpoint de solicitud de EPI valida que el trabajador sea un operador del ticket, sin consultar a Pumping.
CREATE TABLE "ticket_operador" (
    "ticket_id" UUID NOT NULL,
    "usuario_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ticket_operador_pkey" PRIMARY KEY ("ticket_id", "usuario_id"),
    CONSTRAINT "ticket_operador_ticket_fkey" FOREIGN KEY ("ticket_id") REFERENCES "ticket_ref" ("ticket_id") ON DELETE CASCADE,
    CONSTRAINT "ticket_operador_usuario_fkey" FOREIGN KEY ("usuario_id") REFERENCES identidad.usuario ("id")
);
CREATE INDEX "ticket_operador_usuario_id_idx" ON "ticket_operador" ("usuario_id");
GRANT DELETE ON "ticket_operador" TO app_qhse;
COMMENT ON TABLE "ticket_operador" IS 'Operadores asignados al ticket de Pumping. Se reemplazan con cada evento operaciones.pumping.asignacion_realizada.';
COMMENT ON COLUMN "ticket_operador"."usuario_id" IS 'Cuenta del operador (identidad.usuario, FK real).';

-- Los tickets que ya tenían solicitudes de EPI conservan a esos trabajadores como operadores asignados.
INSERT INTO "ticket_operador" ("ticket_id", "usuario_id")
SELECT DISTINCT "ticket_id", "trabajador_id" FROM "epi_entrega" WHERE "ticket_id" IS NOT NULL
ON CONFLICT DO NOTHING;
