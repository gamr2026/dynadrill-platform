-- Salida de bodega por repuestos usados en Mantenimiento (se registra cuando el Jefe aprueba el cierre de la sub-orden).

-- 1. El motivo de ese origen es siempre una salida.
ALTER TABLE "motivo_movimiento" DROP CONSTRAINT "motivo_movimiento_origen_tipo_check";
ALTER TABLE "motivo_movimiento" ADD CONSTRAINT "motivo_movimiento_origen_tipo_check" CHECK (
    ("origen" IN ('saldo_inicial', 'compra', 'devolucion_ticket') AND "tipo" = 'entrada')
    OR ("origen" IN ('despacho_bodega', 'salida_ticket', 'consumo_mantenimiento') AND "tipo" = 'salida')
    OR "origen" = 'ajuste'
);

-- 2. Qué renglón de repuesto de Mantenimiento originó cada salida. Sirve de llave de idempotencia: si el cierre se reintenta
--    (por ejemplo, por un corte entre la salida y el cierre de la sub-orden), la salida no se duplica.
--    La FK va en el sentido Mantenimiento → Inventario (`mantenimiento.suborden_repuesto.movimiento_id`), no al revés: Mantenimiento ya
--    depende de Inventario y una FK inversa haría circulares las migraciones. Por eso `suborden_repuesto_id` es un uuid sin FK; es la
--    única referencia de Inventario hacia Mantenimiento y no se usa para nada más que esa llave.
CREATE TABLE "salida_mantenimiento" (
    "suborden_repuesto_id" UUID NOT NULL,
    "movimiento_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "salida_mantenimiento_pkey" PRIMARY KEY ("suborden_repuesto_id"),
    CONSTRAINT "salida_mantenimiento_movimiento_fkey" FOREIGN KEY ("movimiento_id") REFERENCES "movimiento"("id")
);
CREATE UNIQUE INDEX "salida_mantenimiento_movimiento_key" ON "salida_mantenimiento"("movimiento_id");
REVOKE UPDATE, DELETE ON "salida_mantenimiento" FROM app_operaciones;
COMMENT ON TABLE "salida_mantenimiento" IS 'Salida de bodega de un repuesto usado en Mantenimiento. Inmutable. suborden_repuesto_id (mantenimiento.suborden_repuesto) no tiene FK a propósito: la dependencia va de Mantenimiento hacia Inventario; aquí solo es la llave de idempotencia.';
COMMENT ON COLUMN "movimiento"."origen" IS 'consumo_mantenimiento: repuesto usado en una sub-orden; se rastrea desde mantenimiento.suborden_repuesto.movimiento_id (sin columna de referencia aquí para no invertir la dependencia).';
