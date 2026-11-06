-- Jornadas: cuando el Jefe de Base acorta o amplía la duración de un servicio, Comercial aplica la nueva fecha de fin al pedido y deja aquí el
-- porqué. La prefactura y el avance documental ya no cuentan los días que quedan fuera del servicio, y con esta bitácora se puede explicar el motivo.
-- Solo se agrega.
CREATE TABLE "pedido_cambio_duracion" (
    "id" UUID NOT NULL,
    "pedido_id" UUID NOT NULL,
    "accion" TEXT NOT NULL,
    "fecha_fin_anterior" DATE,
    "fecha_fin_nueva" DATE NOT NULL,
    "motivo" TEXT NOT NULL,
    -- ticket de Pumping que lo decidió (solo para mostrarlo)
    "ticket_numero" INTEGER,
    "actor_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "pedido_cambio_duracion_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "pedido_cambio_duracion_pedido_fkey" FOREIGN KEY ("pedido_id") REFERENCES "pedido" ("id") ON DELETE CASCADE,
    CONSTRAINT "pedido_cambio_duracion_accion_check" CHECK ("accion" IN ('acortar', 'ampliar')),
    CONSTRAINT "pedido_cambio_duracion_motivo_check" CHECK (length(btrim("motivo")) >= 3)
);
CREATE INDEX "pedido_cambio_duracion_pedido_id_created_at_idx" ON "pedido_cambio_duracion" ("pedido_id", "created_at");
GRANT SELECT, INSERT ON "pedido_cambio_duracion" TO app_comercial;
REVOKE UPDATE, DELETE, TRUNCATE ON "pedido_cambio_duracion" FROM app_comercial;
COMMENT ON TABLE "pedido_cambio_duracion" IS 'Cambios de la fecha de fin del servicio que decidió Operaciones (acortar o ampliar) y su motivo. Solo se agrega.';
