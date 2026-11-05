-- Jornadas (etapa 6): el Jefe de Base acorta o amplía la duración del servicio. La fecha de fin es del pedido (Comercial): Pumping la cambia en el
-- ticket de inmediato, avisa a Comercial para que la aplique al pedido y, si Comercial no puede (el pedido ya está congelado), la revierte.
-- Esta tabla es la bitácora de esos cambios: solo se agrega.
CREATE TYPE "pumping"."accion_duracion" AS ENUM ('acortar', 'ampliar', 'revertir');

CREATE TABLE "pumping"."ticket_duracion_cambio" (
    "id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "accion" "pumping"."accion_duracion" NOT NULL,
    "fecha_fin_anterior" DATE NOT NULL,
    "fecha_fin_nueva" DATE NOT NULL,
    "motivo" TEXT NOT NULL,
    -- quién decidió; vacío cuando el cambio lo revierte el sistema porque Comercial no pudo aplicarlo
    "actor_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ticket_duracion_cambio_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ticket_duracion_cambio_ticket_fkey" FOREIGN KEY ("ticket_id") REFERENCES "pumping"."ticket" ("id") ON DELETE CASCADE,
    CONSTRAINT "ticket_duracion_cambio_actor_fkey" FOREIGN KEY ("actor_id") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "ticket_duracion_cambio_motivo_check" CHECK (length(btrim("motivo")) >= 3),
    CONSTRAINT "ticket_duracion_cambio_cambia_check" CHECK ("fecha_fin_anterior" <> "fecha_fin_nueva"),
    CONSTRAINT "ticket_duracion_cambio_actor_check" CHECK ("accion" = 'revertir' OR "actor_id" IS NOT NULL)
);
CREATE INDEX "ticket_duracion_cambio_ticket_id_created_at_idx" ON "pumping"."ticket_duracion_cambio" ("ticket_id", "created_at");
CREATE INDEX "ticket_duracion_cambio_actor_id_idx" ON "pumping"."ticket_duracion_cambio" ("actor_id");
GRANT SELECT, INSERT ON "pumping"."ticket_duracion_cambio" TO app_operaciones;
REVOKE UPDATE, DELETE, TRUNCATE ON "pumping"."ticket_duracion_cambio" FROM app_operaciones;
COMMENT ON TABLE "pumping"."ticket_duracion_cambio" IS 'Bitácora de los cambios de la fecha de fin del servicio (acortar, ampliar, o revertir cuando Comercial no pudo aplicarlo). Solo se agrega.';
