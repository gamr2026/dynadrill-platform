-- Devolución a bodega por anulación del pedido (la hace el sistema) y devoluciones pendientes.
--
-- 1. El kardex guardaba SIEMPRE una cuenta como autor (`responsable_id` NOT NULL). Una devolución por anulación no la hace una persona:
--    no se inventa una cuenta, el autor queda vacío SOLO para ese origen (CHECK) y `a_pedido_de_id` guarda, cuando se sabe, quién anuló el pedido.
ALTER TABLE "inventario"."movimiento"
  ALTER COLUMN "responsable_id" DROP NOT NULL,
  ADD COLUMN "a_pedido_de_id" UUID,
  ADD CONSTRAINT "movimiento_a_pedido_de_id_fkey" FOREIGN KEY ("a_pedido_de_id") REFERENCES identidad.usuario ("id"),
  ADD CONSTRAINT "movimiento_autor_check" CHECK (("responsable_id" IS NULL) = ("origen" = 'devolucion_anulacion')),
  ADD CONSTRAINT "movimiento_a_pedido_de_check" CHECK ("a_pedido_de_id" IS NULL OR "origen" = 'devolucion_anulacion');
CREATE INDEX "movimiento_a_pedido_de_id_idx" ON "inventario"."movimiento" ("a_pedido_de_id");
COMMENT ON COLUMN "inventario"."movimiento"."responsable_id" IS 'Quién registró el movimiento. Vacío solo en `devolucion_anulacion`: la registra el sistema.';
COMMENT ON COLUMN "inventario"."movimiento"."a_pedido_de_id" IS 'Solo en `devolucion_anulacion`: la cuenta que anuló el pedido, cuando se sabe (referencia, no autor).';

-- 2. Una devolución de anulación es una entrada y, como las demás del ticket, lleva el ticket.
ALTER TABLE "inventario"."motivo_movimiento" DROP CONSTRAINT "motivo_movimiento_origen_tipo_check";
ALTER TABLE "inventario"."motivo_movimiento" ADD CONSTRAINT "motivo_movimiento_origen_tipo_check" CHECK (
    ("origen" IN ('saldo_inicial', 'compra', 'devolucion_ticket', 'devolucion_anulacion') AND "tipo" = 'entrada')
    OR ("origen" IN ('despacho_bodega', 'salida_ticket', 'consumo_mantenimiento') AND "tipo" = 'salida')
    OR "origen" = 'ajuste'
);
ALTER TABLE "inventario"."movimiento" DROP CONSTRAINT "movimiento_referencia_check";
ALTER TABLE "inventario"."movimiento" ADD CONSTRAINT "movimiento_referencia_check" CHECK (
    ("origen" IN ('salida_ticket', 'devolucion_ticket', 'devolucion_anulacion')) = (num_nonnulls("ticket_pumping_id") = 1)
    AND ("origen" = 'despacho_bodega') = ("despacho_id" IS NOT NULL)
);
INSERT INTO "inventario"."motivo_movimiento" ("id", "nombre", "tipo", "origen", "manual")
VALUES (gen_random_uuid(), 'Devolución por anulación del pedido', 'entrada', 'devolucion_anulacion', false)
ON CONFLICT ("nombre") DO NOTHING;

-- 3. Devolución pendiente: lo que la anulación no pudo devolver (bodega inhabilitada, error) queda a cargo del ticket y aquí a la vista de Bodega,
--    que lo resuelve (registra la devolución). Una sola fila abierta por ticket, artículo y bodega: reintentar la anulación no la duplica.
CREATE TABLE "inventario"."devolucion_pendiente" (
    "id" UUID NOT NULL,
    "ticket_pumping_id" UUID NOT NULL,
    "articulo_id" UUID NOT NULL,
    "bodega_id" UUID NOT NULL,
    "cantidad" DECIMAL(14,3) NOT NULL,
    "motivo" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resuelta_at" TIMESTAMPTZ(6),
    "resuelta_por" UUID,
    "movimiento_id" UUID,
    CONSTRAINT "devolucion_pendiente_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "devolucion_pendiente_ticket_fkey" FOREIGN KEY ("ticket_pumping_id") REFERENCES pumping.ticket ("id"),
    CONSTRAINT "devolucion_pendiente_articulo_fkey" FOREIGN KEY ("articulo_id") REFERENCES "inventario"."articulo" ("id"),
    CONSTRAINT "devolucion_pendiente_bodega_fkey" FOREIGN KEY ("bodega_id") REFERENCES catalogos.bodega ("id"),
    CONSTRAINT "devolucion_pendiente_resuelta_por_fkey" FOREIGN KEY ("resuelta_por") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "devolucion_pendiente_movimiento_fkey" FOREIGN KEY ("movimiento_id") REFERENCES "inventario"."movimiento" ("id"),
    CONSTRAINT "devolucion_pendiente_cantidad_check" CHECK ("cantidad" > 0),
    CONSTRAINT "devolucion_pendiente_motivo_check" CHECK (length(btrim("motivo")) > 0),
    -- quien la resolvió y el movimiento que hizo solo existen si está resuelta
    CONSTRAINT "devolucion_pendiente_resuelta_check" CHECK (("resuelta_por" IS NULL AND "movimiento_id" IS NULL) OR "resuelta_at" IS NOT NULL)
);
CREATE UNIQUE INDEX "devolucion_pendiente_abierta_key"
  ON "inventario"."devolucion_pendiente" ("ticket_pumping_id", "articulo_id", "bodega_id") WHERE "resuelta_at" IS NULL;
CREATE INDEX "devolucion_pendiente_abiertas_idx" ON "inventario"."devolucion_pendiente" ("created_at") WHERE "resuelta_at" IS NULL;
CREATE INDEX "devolucion_pendiente_articulo_id_idx" ON "inventario"."devolucion_pendiente" ("articulo_id");
CREATE INDEX "devolucion_pendiente_bodega_id_idx" ON "inventario"."devolucion_pendiente" ("bodega_id");
CREATE INDEX "devolucion_pendiente_resuelta_por_idx" ON "inventario"."devolucion_pendiente" ("resuelta_por");
CREATE INDEX "devolucion_pendiente_movimiento_id_idx" ON "inventario"."devolucion_pendiente" ("movimiento_id");
GRANT SELECT, INSERT, UPDATE ON "inventario"."devolucion_pendiente" TO app_operaciones;
REVOKE DELETE ON "inventario"."devolucion_pendiente" FROM app_operaciones;
COMMENT ON TABLE "inventario"."devolucion_pendiente" IS 'Lo que una anulación de pedido no pudo devolver a bodega: sigue a cargo del ticket hasta que Bodega lo resuelve (la devolución real es un movimiento del kardex). Sin DELETE: es historia.';
COMMENT ON COLUMN "inventario"."devolucion_pendiente"."motivo" IS 'Por qué no se pudo devolver (el mensaje del rechazo).';
COMMENT ON COLUMN "inventario"."devolucion_pendiente"."resuelta_por" IS 'Quien la resolvió; vacío si se resolvió sola (la anulación se reintentó y devolvió todo).';
