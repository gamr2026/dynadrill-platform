-- Supervisor responsable del ticket (12/11/2026): hay varios Supervisores de FCR y cada ticket debe tener a quien le pertenece en su bandeja.
ALTER TABLE "fcr"."ticket"
  ADD COLUMN "responsable_id" UUID,
  ADD CONSTRAINT "ticket_responsable_fkey" FOREIGN KEY ("responsable_id") REFERENCES identidad.usuario ("id");
CREATE INDEX "ticket_responsable_idx" ON "fcr"."ticket" ("responsable_id");
COMMENT ON COLUMN "fcr"."ticket"."responsable_id" IS 'Supervisor de FCR a quien le pertenece el ticket en la bandeja (identidad.usuario). NULL: sin asignar. No restringe quién puede ver el ticket.';

CREATE TABLE "fcr"."ticket_responsable_historial" (
    "id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "anterior_id" UUID,
    "nuevo_id" UUID,
    "motivo" TEXT,
    "actor_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ticket_responsable_historial_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ticket_responsable_historial_ticket_fkey" FOREIGN KEY ("ticket_id") REFERENCES "fcr"."ticket" ("id") ON DELETE CASCADE,
    CONSTRAINT "ticket_responsable_historial_anterior_fkey" FOREIGN KEY ("anterior_id") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "ticket_responsable_historial_nuevo_fkey" FOREIGN KEY ("nuevo_id") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "ticket_responsable_historial_actor_fkey" FOREIGN KEY ("actor_id") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "ticket_responsable_historial_cambio_check" CHECK ("anterior_id" IS DISTINCT FROM "nuevo_id"),
    CONSTRAINT "ticket_responsable_historial_motivo_check" CHECK ("motivo" IS NULL OR length(btrim("motivo")) > 0)
);
CREATE INDEX "ticket_responsable_historial_ticket_idx" ON "fcr"."ticket_responsable_historial" ("ticket_id", "created_at");
CREATE INDEX "ticket_responsable_historial_anterior_idx" ON "fcr"."ticket_responsable_historial" ("anterior_id");
CREATE INDEX "ticket_responsable_historial_nuevo_idx" ON "fcr"."ticket_responsable_historial" ("nuevo_id");
CREATE INDEX "ticket_responsable_historial_actor_idx" ON "fcr"."ticket_responsable_historial" ("actor_id");
-- la historia no se edita ni se borra: un error se corrige con un registro nuevo
REVOKE UPDATE, DELETE ON "fcr"."ticket_responsable_historial" FROM app_operaciones;
COMMENT ON TABLE "fcr"."ticket_responsable_historial" IS 'Quién fue responsable del ticket y cuándo cambió (tomar, asignar, reasignar, liberar). Inmutable.';
COMMENT ON COLUMN "fcr"."ticket_responsable_historial"."anterior_id" IS 'NULL: el ticket no tenía responsable.';
COMMENT ON COLUMN "fcr"."ticket_responsable_historial"."nuevo_id" IS 'NULL: el ticket quedó sin responsable (liberado).';

-- Los tickets que ya tienen supervisor en su equipo lo conservan como responsable
UPDATE "fcr"."ticket" t SET "responsable_id" = p."usuario_id"
FROM "fcr"."ticket_persona" p
WHERE p."ticket_id" = t."id" AND p."rol" = 'supervisor';
INSERT INTO "fcr"."ticket_responsable_historial" ("id", "ticket_id", "anterior_id", "nuevo_id", "motivo", "actor_id")
SELECT gen_random_uuid(), t."id", NULL, t."responsable_id", 'Supervisor ya asignado al equipo del ticket', NULL
FROM "fcr"."ticket" t WHERE t."responsable_id" IS NOT NULL;
