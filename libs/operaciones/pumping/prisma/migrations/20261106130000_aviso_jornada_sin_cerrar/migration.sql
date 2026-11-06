-- Aviso «Jornada sin cerrar»: cuando pasa un día de servicio y su jornada sigue pendiente o abierta, se avisa una sola vez al equipo del ticket (Supervisor y
-- Operadores). Esta tabla recuerda de qué jornadas ya se avisó, para no repetir el aviso en cada revisión. Solo se agrega.
CREATE TABLE "pumping"."ticket_aviso_jornada" (
    "ticket_id" UUID NOT NULL,
    "fecha" DATE NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ticket_aviso_jornada_pkey" PRIMARY KEY ("ticket_id", "fecha"),
    CONSTRAINT "ticket_aviso_jornada_ticket_fkey" FOREIGN KEY ("ticket_id") REFERENCES "pumping"."ticket" ("id") ON DELETE CASCADE
);
GRANT SELECT, INSERT ON "pumping"."ticket_aviso_jornada" TO app_operaciones;
REVOKE UPDATE, DELETE, TRUNCATE ON "pumping"."ticket_aviso_jornada" FROM app_operaciones;
COMMENT ON TABLE "pumping"."ticket_aviso_jornada" IS 'Jornadas de días pasados que siguen sin cerrar y de las que ya se avisó al equipo (un aviso por ticket y día). Solo se agrega.';
