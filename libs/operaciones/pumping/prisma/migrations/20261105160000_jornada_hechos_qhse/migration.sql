-- Jornadas (etapa 5a): lo que QHSE hace por día (PTW aprobado, PT cargado, ART vigente) llega a Pumping por eventos y se guarda aquí, aparte de
-- las jornadas: el PTW o el PT pueden cargarse días antes de que existan las jornadas del ticket, y el ART cubre un rango de días. De esta tabla
-- sale si cada día cumple sus requisitos de apertura de QHSE.

CREATE TYPE "pumping"."tipo_hecho_qhse" AS ENUM ('ptw_aprobado', 'pt', 'art');

CREATE TABLE "pumping"."ticket_hecho_qhse" (
    "id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "tipo" "pumping"."tipo_hecho_qhse" NOT NULL,
    -- el PTW o el documento de QHSE que lo originó (otro contenedor, D1: uuid sin FK)
    "origen_id" UUID NOT NULL,
    "desde" DATE NOT NULL,
    "hasta" DATE NOT NULL,
    "vigente" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ticket_hecho_qhse_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ticket_hecho_qhse_ticket_fkey" FOREIGN KEY ("ticket_id") REFERENCES "pumping"."ticket" ("id") ON DELETE CASCADE,
    CONSTRAINT "ticket_hecho_qhse_rango_check" CHECK ("desde" <= "hasta")
);
CREATE UNIQUE INDEX "ticket_hecho_qhse_origen_key" ON "pumping"."ticket_hecho_qhse" ("ticket_id", "tipo", "origen_id");
GRANT SELECT, INSERT, UPDATE ON "pumping"."ticket_hecho_qhse" TO app_operaciones;
COMMENT ON TABLE "pumping"."ticket_hecho_qhse" IS 'Hechos de QHSE por día del ticket recibidos por eventos: PTW aprobado (un día), PT cargado (un día) y ART vigente (rango). `vigente = false` cuando QHSE los anula. Un día cumple el requisito si algún hecho vigente del tipo lo cubre.';

-- ya se exigen para abrir la jornada: PTW del día aprobado, PT del día cargado y ART vigente que cubra el día
UPDATE "pumping"."requisito" SET "activo" = true WHERE "codigo" IN ('ptw_dia_aprobado', 'pt_dia_cargado', 'art_vigente');
