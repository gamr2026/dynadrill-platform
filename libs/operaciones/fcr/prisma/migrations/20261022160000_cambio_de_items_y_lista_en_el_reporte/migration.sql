-- 1) Cada fila del reporte guarda el ítem de la lista de precios del cliente (en `comercial`, otro contenedor: uuid sin FK) para poder proponer el
--    cambio de lo cotizado con lo realmente usado.
ALTER TABLE "reporte_item" ADD COLUMN "lista_precios_item_id" UUID NOT NULL;
COMMENT ON COLUMN "reporte_item"."lista_precios_item_id" IS 'Ítem de la lista de precios del cliente en `comercial` (otro contenedor, D1): uuid sin FK.';

-- 2) Solicitudes de cambio de ítems del pedido (contrato 4.13, igual que Pumping): el Operador del equipo propone la lista de ítems que debe
--    quedar en el pedido y el Supervisor del ticket la aprueba o la rechaza. Al aprobar se publica `operaciones.fcr.cambio_items_aprobado`; Comercial
--    aplica el cambio (y recalcula la prefactura si aún no salió al cliente) y responde con `comercial.cambio_items.resultado`.
CREATE TYPE "estado_solicitud_items" AS ENUM ('pendiente', 'aprobada', 'rechazada');
CREATE TYPE "aplicacion_cambio_items" AS ENUM ('pendiente', 'aplicada', 'no_aplicada');

CREATE TABLE "solicitud_cambio_items" (
    "id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "estado" "estado_solicitud_items" NOT NULL DEFAULT 'pendiente',
    "motivo" TEXT NOT NULL,
    "solicitado_por" UUID NOT NULL,
    "solicitado_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revisado_por" UUID,
    "revisado_at" TIMESTAMPTZ(6),
    "motivo_rechazo" TEXT,
    "aplicacion" "aplicacion_cambio_items",
    "aplicacion_motivo" TEXT,
    "aplicada_at" TIMESTAMPTZ(6),
    CONSTRAINT "solicitud_cambio_items_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "solicitud_cambio_items_ticket_fkey" FOREIGN KEY ("ticket_id") REFERENCES "ticket"("id") ON DELETE CASCADE,
    CONSTRAINT "solicitud_cambio_items_solicitado_por_fkey" FOREIGN KEY ("solicitado_por") REFERENCES identidad.usuario("id"),
    CONSTRAINT "solicitud_cambio_items_revisado_por_fkey" FOREIGN KEY ("revisado_por") REFERENCES identidad.usuario("id"),
    CONSTRAINT "solicitud_cambio_items_motivo_check" CHECK (length(btrim("motivo")) > 0),
    CONSTRAINT "solicitud_cambio_items_revision_par_check" CHECK (("revisado_por" IS NULL) = ("revisado_at" IS NULL)),
    CONSTRAINT "solicitud_cambio_items_revision_check" CHECK (("estado" = 'pendiente') = ("revisado_por" IS NULL)),
    CONSTRAINT "solicitud_cambio_items_rechazo_check" CHECK ("motivo_rechazo" IS NULL OR "estado" = 'rechazada'),
    CONSTRAINT "solicitud_cambio_items_aplicacion_check" CHECK (("estado" = 'aprobada') = ("aplicacion" IS NOT NULL)),
    CONSTRAINT "solicitud_cambio_items_aplicacion_motivo_check" CHECK ("aplicacion_motivo" IS NULL OR "aplicacion" = 'no_aplicada'),
    CONSTRAINT "solicitud_cambio_items_aplicada_at_check" CHECK (("aplicacion" IN ('aplicada', 'no_aplicada')) = ("aplicada_at" IS NOT NULL))
);
CREATE UNIQUE INDEX "solicitud_cambio_items_pendiente_key" ON "solicitud_cambio_items"("ticket_id") WHERE "estado" = 'pendiente';
CREATE INDEX "solicitud_cambio_items_ticket_idx" ON "solicitud_cambio_items"("ticket_id", "solicitado_at");

CREATE TABLE "solicitud_cambio_item" (
    "id" UUID NOT NULL,
    "solicitud_id" UUID NOT NULL,
    "orden" INTEGER NOT NULL,
    "lista_precios_item_id" UUID NOT NULL,
    "codigo" TEXT NOT NULL,
    "descripcion" TEXT NOT NULL,
    "unidad" TEXT NOT NULL,
    "cantidad" NUMERIC(12,3) NOT NULL,
    "descuento_pct" NUMERIC(5,2),
    "tipo_linea" "tipo_linea" NOT NULL,
    CONSTRAINT "solicitud_cambio_item_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "solicitud_cambio_item_solicitud_fkey" FOREIGN KEY ("solicitud_id") REFERENCES "solicitud_cambio_items"("id") ON DELETE CASCADE,
    CONSTRAINT "solicitud_cambio_item_orden_check" CHECK ("orden" >= 1),
    CONSTRAINT "solicitud_cambio_item_cantidad_check" CHECK ("cantidad" > 0),
    CONSTRAINT "solicitud_cambio_item_descuento_check" CHECK ("descuento_pct" IS NULL OR "descuento_pct" BETWEEN 0 AND 100)
);
CREATE UNIQUE INDEX "solicitud_cambio_item_orden_key" ON "solicitud_cambio_item"("solicitud_id", "orden");
CREATE UNIQUE INDEX "solicitud_cambio_item_lista_key" ON "solicitud_cambio_item"("solicitud_id", "lista_precios_item_id");
-- lo propuesto es historia: no se cambia ni se borra
REVOKE UPDATE, DELETE ON "solicitud_cambio_item" FROM app_operaciones;

COMMENT ON TABLE "solicitud_cambio_items" IS 'Solicitud de cambio de ítems del pedido: la propone el Operador del equipo y la aprueba o rechaza el Supervisor del ticket. `aplicacion` es la respuesta de Comercial (otro contenedor).';
COMMENT ON TABLE "solicitud_cambio_item" IS 'Lista de ítems que debe quedar en el pedido si se aprueba. Inmutable.';
COMMENT ON COLUMN "solicitud_cambio_item"."lista_precios_item_id" IS 'Ítem de la lista de precios del cliente en `comercial` (otro contenedor, D1): uuid sin FK.';
COMMENT ON COLUMN "solicitud_cambio_item"."codigo" IS 'Código copiado de la lista de precios solo para mostrar la solicitud sin consultar Comercial. El precio NO se copia: lo pone Comercial al aplicar.';
COMMENT ON COLUMN "solicitud_cambio_item"."descripcion" IS 'Descripción copiada de la lista de precios, solo para mostrar la solicitud.';
