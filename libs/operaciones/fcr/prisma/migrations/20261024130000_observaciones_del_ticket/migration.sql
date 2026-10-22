-- Observaciones del ticket (botón «Observaciones» de la demo): notas con autor y fecha, que se agregan desde cualquier fase y no se editan.

CREATE TABLE "ticket_observacion" (
    "id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "mensaje" TEXT NOT NULL,
    "autor_rol" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    CONSTRAINT "ticket_observacion_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ticket_observacion_ticket_fkey" FOREIGN KEY ("ticket_id") REFERENCES "ticket" ("id") ON DELETE CASCADE,
    CONSTRAINT "ticket_observacion_autor_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "ticket_observacion_rol_fkey" FOREIGN KEY ("autor_rol") REFERENCES identidad.rol ("codigo"),
    CONSTRAINT "ticket_observacion_mensaje_check" CHECK (length(btrim("mensaje")) BETWEEN 1 AND 2000)
);
CREATE INDEX "ticket_observacion_ticket_idx" ON "ticket_observacion" ("ticket_id", "created_at");
CREATE INDEX "ticket_observacion_autor_idx" ON "ticket_observacion" ("created_by");
-- una observación es un registro histórico: un error se corrige con otra observación
REVOKE UPDATE, DELETE ON "ticket_observacion" FROM app_operaciones;
COMMENT ON TABLE "ticket_observacion" IS 'Observaciones del ticket FCR: quién, con qué rol y cuándo. Inmutable (sin UPDATE ni DELETE para la aplicación); se borra solo junto con el ticket.';
COMMENT ON COLUMN "ticket_observacion"."autor_rol" IS 'Rol con el que escribió (dato histórico: la cuenta puede cambiar de rol después).';
COMMENT ON COLUMN "ticket_observacion"."created_by" IS 'Autor de la observación (identidad.usuario). No hay updated_*: el registro no se edita.';
