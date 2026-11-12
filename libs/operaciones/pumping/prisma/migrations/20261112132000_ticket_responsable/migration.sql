-- Jefe de Base responsable del ticket: hay más de uno y cada ticket nuevo aparecía en la bandeja de todos sin dueño. El responsable puede quedar vacío
-- (nadie lo tomó o se liberó). No limita quién ve o abre el ticket; solo ordena la bandeja («mías», «sin asignar»).
ALTER TABLE "pumping"."ticket"
  ADD COLUMN "responsable_id" UUID,
  ADD CONSTRAINT "ticket_responsable_fkey" FOREIGN KEY ("responsable_id") REFERENCES identidad.usuario ("id");
CREATE INDEX "ticket_responsable_idx" ON "pumping"."ticket" ("responsable_id");
COMMENT ON COLUMN "pumping"."ticket"."responsable_id" IS 'Jefe de Base responsable del ticket (FK a identidad.usuario); vacío mientras nadie lo tome. Cada cambio queda en ticket_responsable_historial.';

-- Historia (solo se agrega): quién pasó a ser responsable, quién lo era, por qué y quién lo hizo
CREATE TABLE "pumping"."ticket_responsable_historial" (
    "id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    -- vacío cuando el ticket no tenía responsable
    "anterior_id" UUID,
    -- vacío cuando se libera
    "nuevo_id" UUID,
    "motivo" TEXT NOT NULL,
    "actor_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ticket_responsable_historial_pkey" PRIMARY KEY ("id"),
    -- la historia se va con el ticket que la origina; la aplicación no puede borrarla
    CONSTRAINT "ticket_responsable_historial_ticket_fkey" FOREIGN KEY ("ticket_id") REFERENCES "pumping"."ticket" ("id") ON DELETE CASCADE,
    CONSTRAINT "ticket_responsable_historial_anterior_fkey" FOREIGN KEY ("anterior_id") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "ticket_responsable_historial_nuevo_fkey" FOREIGN KEY ("nuevo_id") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "ticket_responsable_historial_actor_fkey" FOREIGN KEY ("actor_id") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "ticket_responsable_historial_cambio_check" CHECK ("anterior_id" IS DISTINCT FROM "nuevo_id"),
    CONSTRAINT "ticket_responsable_historial_motivo_check" CHECK (length(btrim("motivo")) > 0)
);
CREATE INDEX "ticket_responsable_historial_ticket_idx" ON "pumping"."ticket_responsable_historial" ("ticket_id", "created_at");
GRANT SELECT, INSERT ON "pumping"."ticket_responsable_historial" TO app_operaciones;
REVOKE UPDATE, DELETE, TRUNCATE ON "pumping"."ticket_responsable_historial" FROM app_operaciones;
COMMENT ON TABLE "pumping"."ticket_responsable_historial" IS 'Cada cambio del Jefe de Base responsable de un ticket (toma, asignación, reasignación, liberación), con motivo y quién lo hizo. Solo se agrega.';
COMMENT ON COLUMN "pumping"."ticket_responsable_historial"."motivo" IS 'Obligatorio. En las acciones del sistema (el primer paso del Jefe de Base en la revisión inicial) lleva un motivo de sistema.';
