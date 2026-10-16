-- Asignación del Jefe de Base: supervisor, operadores y unidades de cada ticket.
CREATE TYPE "rol_asignado" AS ENUM ('supervisor', 'operador');

CREATE TABLE "ticket_persona" (
    "ticket_id" UUID NOT NULL,
    "usuario_id" UUID NOT NULL,
    "usuario_nombre" TEXT NOT NULL,
    "rol" "rol_asignado" NOT NULL,
    "asignado_por" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ticket_persona_pkey" PRIMARY KEY ("ticket_id", "usuario_id")
);
CREATE INDEX "ticket_persona_usuario_id_idx" ON "ticket_persona"("usuario_id");
ALTER TABLE "ticket_persona" ADD CONSTRAINT "ticket_persona_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ticket_unidad" (
    "ticket_id" UUID NOT NULL,
    "vehiculo_id" UUID NOT NULL,
    "placa" TEXT NOT NULL,
    "descripcion" TEXT,
    "asignado_por" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ticket_unidad_pkey" PRIMARY KEY ("ticket_id", "vehiculo_id")
);
ALTER TABLE "ticket_unidad" ADD CONSTRAINT "ticket_unidad_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Reasignar reemplaza lo anterior (borra y vuelve a crear).
GRANT DELETE ON "ticket_persona", "ticket_unidad" TO app_operaciones;
