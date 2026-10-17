-- Inventario: correcciones de la revisión de base de datos (17/10/2026). Ver el plan, «Hallazgos de la revisión».
-- Depende de que exista el schema `pumping` (FK a `pumping.ticket`): se aplica después de `db:migrate:pumping`.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "movimiento" WHERE "ticket_id" IS NOT NULL OR "pedido_id" IS NOT NULL) THEN
    RAISE EXCEPTION 'Hay movimientos con ticket_id o pedido_id: migre esos datos antes de quitar las columnas';
  END IF;
END $$;

-- 1. `tipo` y `origen` del movimiento: se conservan (el kardex los usa en sus reglas y no cambian nunca), pero la base garantiza
--    que coinciden con los de su motivo con una FK compuesta, en lugar de un CHECK que repite las reglas del motivo.
ALTER TABLE "motivo_movimiento" ADD CONSTRAINT "motivo_movimiento_id_tipo_origen_key" UNIQUE ("id", "tipo", "origen");
ALTER TABLE "movimiento" DROP CONSTRAINT "movimiento_origen_tipo_check";
ALTER TABLE "movimiento" DROP CONSTRAINT "movimiento_motivo_id_fkey";
ALTER TABLE "movimiento" ADD CONSTRAINT "movimiento_motivo_tipo_origen_fkey"
    FOREIGN KEY ("motivo_id", "tipo", "origen") REFERENCES "motivo_movimiento"("id", "tipo", "origen")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

-- 2. Despachos a bodega: espejo mínimo de lo que comercial publica (`comercial.despacho.solicitado|resuelto`). El pedido es de otro
--    contenedor (comercial): uuid sin FK, como manda D1. Los archivos sí son tablas maestras (FK real).
CREATE TYPE "estado_despacho" AS ENUM ('solicitado', 'realizado');

CREATE TABLE "despacho" (
    "id" UUID NOT NULL,
    "pedido_id" UUID NOT NULL,
    "estado" "estado_despacho" NOT NULL,
    "solicitado_at" TIMESTAMPTZ(6) NOT NULL,
    "solicitado_por" UUID NOT NULL,
    "realizado_at" TIMESTAMPTZ(6),
    "realizado_por" UUID,
    "archivo_respaldo_id" UUID,
    "archivo_msds_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID NOT NULL,
    CONSTRAINT "despacho_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "despacho_pedido_id_key" ON "despacho"("pedido_id");
CREATE INDEX "despacho_estado_idx" ON "despacho"("estado");
ALTER TABLE "despacho"
    ADD CONSTRAINT "despacho_solicitado_por_fkey" FOREIGN KEY ("solicitado_por") REFERENCES identidad.usuario("id"),
    ADD CONSTRAINT "despacho_realizado_por_fkey" FOREIGN KEY ("realizado_por") REFERENCES identidad.usuario("id"),
    ADD CONSTRAINT "despacho_archivo_respaldo_id_fkey" FOREIGN KEY ("archivo_respaldo_id") REFERENCES archivos.archivo("id"),
    ADD CONSTRAINT "despacho_archivo_msds_id_fkey" FOREIGN KEY ("archivo_msds_id") REFERENCES archivos.archivo("id"),
    ADD CONSTRAINT "despacho_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario("id"),
    ADD CONSTRAINT "despacho_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario("id");
-- realizado = quién, cuándo y el documento de respaldo (obligatorio); solicitado = nada de eso
ALTER TABLE "despacho" ADD CONSTRAINT "despacho_estado_check" CHECK (
    ("estado" = 'solicitado' AND "realizado_at" IS NULL AND "realizado_por" IS NULL
        AND "archivo_respaldo_id" IS NULL AND "archivo_msds_id" IS NULL)
    OR ("estado" = 'realizado' AND "realizado_at" IS NOT NULL AND "realizado_por" IS NOT NULL
        AND "archivo_respaldo_id" IS NOT NULL)
);
COMMENT ON TABLE "despacho" IS 'Solicitud de despacho a bodega de un pedido (la marca el ciclo comercial; aquí se registran las salidas de stock que la respaldan).';
COMMENT ON COLUMN "despacho"."pedido_id" IS 'Pedido de comercial (otro contenedor): uuid sin FK (D1). El código y el cliente se consultan en comercial.';

-- 3. Referencias del movimiento: una columna con FK por cada origen (nada de ids sin FK dentro del mismo servidor).
--    Ticket de Pumping (FK real a `pumping.ticket`; FCR agrega su propia columna cuando exista su schema) y despacho.
--    El pedido ya no se guarda en el movimiento: sale del despacho con JOIN.
ALTER TABLE "movimiento" DROP CONSTRAINT "movimiento_referencia_check";
ALTER TABLE "movimiento" DROP COLUMN "ticket_id", DROP COLUMN "pedido_id";
ALTER TABLE "movimiento"
    ADD COLUMN "ticket_pumping_id" UUID,
    ADD COLUMN "despacho_id" UUID;
ALTER TABLE "movimiento"
    ADD CONSTRAINT "movimiento_ticket_pumping_id_fkey" FOREIGN KEY ("ticket_pumping_id") REFERENCES pumping.ticket("id"),
    ADD CONSTRAINT "movimiento_despacho_id_fkey" FOREIGN KEY ("despacho_id") REFERENCES "despacho"("id");
CREATE INDEX "movimiento_ticket_pumping_id_idx" ON "movimiento"("ticket_pumping_id");
CREATE INDEX "movimiento_despacho_id_idx" ON "movimiento"("despacho_id");
-- salida/devolución de ticket ⇔ lleva ticket; despacho a bodega ⇔ lleva despacho; nada más lleva referencia
ALTER TABLE "movimiento" ADD CONSTRAINT "movimiento_referencia_check" CHECK (
    ("origen" IN ('salida_ticket', 'devolucion_ticket')) = (num_nonnulls("ticket_pumping_id") = 1)
    AND ("origen" = 'despacho_bodega') = ("despacho_id" IS NOT NULL)
);
COMMENT ON COLUMN "movimiento"."ticket_pumping_id" IS 'Ticket de Pumping. FCR agregará ticket_fcr_id y su migración cambiará el CHECK a num_nonnulls(ticket_pumping_id, ticket_fcr_id) = 1.';

-- 4. Consumo real de un ticket (ejecución): no mueve stock (lo que sale a un ticket ya salió de bodega; lo que no se usa se devuelve),
--    solo registra cuánto se usó. Asignado y devuelto se obtienen del kardex; aquí no se copian. Historia inmutable.
CREATE TABLE "consumo_ticket" (
    "id" UUID NOT NULL,
    "ticket_pumping_id" UUID NOT NULL,
    "articulo_id" UUID NOT NULL,
    "cantidad" DECIMAL(14,3) NOT NULL,
    "fecha" TIMESTAMPTZ(6) NOT NULL,
    "observacion" TEXT,
    "responsable_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "consumo_ticket_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "consumo_ticket_ticket_pumping_id_articulo_id_idx" ON "consumo_ticket"("ticket_pumping_id", "articulo_id");
ALTER TABLE "consumo_ticket"
    ADD CONSTRAINT "consumo_ticket_ticket_pumping_id_fkey" FOREIGN KEY ("ticket_pumping_id") REFERENCES pumping.ticket("id"),
    ADD CONSTRAINT "consumo_ticket_articulo_id_fkey" FOREIGN KEY ("articulo_id") REFERENCES "articulo"("id"),
    ADD CONSTRAINT "consumo_ticket_responsable_id_fkey" FOREIGN KEY ("responsable_id") REFERENCES identidad.usuario("id"),
    ADD CONSTRAINT "consumo_ticket_cantidad_check" CHECK ("cantidad" > 0);
REVOKE UPDATE, DELETE ON "consumo_ticket" FROM app_operaciones;
COMMENT ON TABLE "consumo_ticket" IS 'Consumo real de un artículo en un ticket de Pumping. Inmutable: un error se corrige con la devolución o un registro nuevo.';

-- 5. Auditoría de los códigos del artículo
ALTER TABLE "articulo_codigo"
    ADD COLUMN "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ADD COLUMN "created_by" UUID,
    ADD COLUMN "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ADD COLUMN "updated_by" UUID,
    ADD CONSTRAINT "articulo_codigo_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario("id"),
    ADD CONSTRAINT "articulo_codigo_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario("id");

-- 6. Documentación de columnas
COMMENT ON COLUMN "articulo"."as2_id" IS 'Id del producto en AS2. Se llena cuando Asinfo exponga productos (consulta B6 y IN7); mientras tanto se concilia por `codigo`, que es el código de producto de AS2.';
COMMENT ON TABLE "unidad_stock" IS 'Unidad de medida del stock. Propia de Inventario por ahora; si se unifica con las unidades de las listas de precios y de AS2 (IN9) pasará a `catalogos`.';
COMMENT ON COLUMN "categoria_articulo"."es_quimica" IS 'La categoría agrupa químicos. El comportamiento del sistema depende de esta marca, nunca del nombre.';
COMMENT ON COLUMN "categoria_articulo"."lleva_partes" IS 'Los artículos de la categoría son herramientas con lista de partes. El comportamiento depende de esta marca, nunca del nombre.';
