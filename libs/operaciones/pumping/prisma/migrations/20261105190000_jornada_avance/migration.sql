-- Jornadas (etapa 6b): aviso al Jefe de Base cuando el avance real del servicio va adelantado respecto del plan (los días transcurridos).
-- Se avisa una sola vez por ticket; esta tabla recuerda que ya se avisó y con qué cifras. Solo se agrega.
CREATE TABLE "pumping"."ticket_aviso_avance" (
    "ticket_id" UUID NOT NULL,
    "avance_real" NUMERIC(5, 1) NOT NULL,
    "avance_plan" NUMERIC(5, 1) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ticket_aviso_avance_pkey" PRIMARY KEY ("ticket_id"),
    CONSTRAINT "ticket_aviso_avance_ticket_fkey" FOREIGN KEY ("ticket_id") REFERENCES "pumping"."ticket" ("id") ON DELETE CASCADE,
    CONSTRAINT "ticket_aviso_avance_rango_check" CHECK ("avance_real" BETWEEN 0 AND 100 AND "avance_plan" BETWEEN 0 AND 100)
);
GRANT SELECT, INSERT ON "pumping"."ticket_aviso_avance" TO app_operaciones;
REVOKE UPDATE, DELETE, TRUNCATE ON "pumping"."ticket_aviso_avance" FROM app_operaciones;
COMMENT ON TABLE "pumping"."ticket_aviso_avance" IS 'Tickets a los que ya se avisó que el avance va adelantado del plan (una vez por ticket). Solo se agrega.';
