-- Días del servicio que Operaciones registró como «sin operación» (lluvia, espera de cliente…), con su motivo. Llegan por el evento
-- `operaciones.pumping.jornada_sin_operacion` (activa = true al registrarlo, false si se reabre el día). Con esto Comercial sabe qué día
-- no necesita Reporte Job para enviar la prefactura al cliente.
CREATE TABLE "pedido_jornada_sin_operacion" (
    "id" UUID NOT NULL,
    "pedido_id" UUID NOT NULL,
    "fecha" DATE NOT NULL,
    "motivo" TEXT NOT NULL,
    "detalle" TEXT,
    -- ticket de Pumping que lo registró (solo para mostrarlo)
    "ticket_numero" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "pedido_jornada_sin_operacion_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "pedido_jornada_sin_operacion_pedido_fkey" FOREIGN KEY ("pedido_id") REFERENCES "pedido" ("id") ON DELETE CASCADE,
    CONSTRAINT "pedido_jornada_sin_operacion_motivo_check" CHECK (length(btrim("motivo")) >= 1)
);
CREATE UNIQUE INDEX "pedido_jornada_sin_operacion_pedido_id_fecha_key" ON "pedido_jornada_sin_operacion" ("pedido_id", "fecha");
GRANT SELECT, INSERT, UPDATE, DELETE ON "pedido_jornada_sin_operacion" TO app_comercial;
REVOKE TRUNCATE ON "pedido_jornada_sin_operacion" FROM app_comercial;
COMMENT ON TABLE "pedido_jornada_sin_operacion" IS 'Días del servicio que Operaciones registró como sin operación, con su motivo. Se llena por evento; un día justificado no exige Reporte Job para enviar la prefactura.';
COMMENT ON COLUMN "pedido_jornada_sin_operacion"."fecha" IS 'Día del servicio (America/Guayaquil) sin operación.';
