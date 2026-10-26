-- CM-5, segunda parte (la primera agregó el estado `rechazado` y el tipo de ítem: un valor nuevo de enum no se usa en la misma
-- transacción en que se crea).

-- Número propio de la solicitud (como en la demo), correlativo desde 1
CREATE SEQUENCE "inventario"."despacho_numero_seq" AS integer START 1;

ALTER TABLE "inventario"."despacho" DROP CONSTRAINT "despacho_estado_check";
DROP INDEX "inventario"."despacho_pedido_id_key";

ALTER TABLE "inventario"."despacho"
  ADD COLUMN "numero" INTEGER NOT NULL DEFAULT nextval('inventario.despacho_numero_seq'),
  ADD COLUMN "pedido_codigo" TEXT,
  ADD COLUMN "cliente_id" UUID,
  ADD COLUMN "bodega_id" UUID NOT NULL,
  ADD COLUMN "fecha_requerida" DATE NOT NULL,
  ADD COLUMN "nota_solicitud" TEXT,
  ADD COLUMN "nota_bodega" TEXT,
  ADD COLUMN "referencia_as2" TEXT,
  ADD COLUMN "rechazado_at" TIMESTAMPTZ(6),
  ADD COLUMN "rechazado_por" UUID,
  ADD COLUMN "motivo_rechazo" TEXT;
ALTER SEQUENCE "inventario"."despacho_numero_seq" OWNED BY "inventario"."despacho"."numero";
GRANT USAGE ON SEQUENCE "inventario"."despacho_numero_seq" TO app_operaciones;

ALTER TABLE "inventario"."despacho"
  ADD CONSTRAINT "despacho_numero_key" UNIQUE ("numero"),
  ADD CONSTRAINT "despacho_cliente_id_fkey" FOREIGN KEY ("cliente_id") REFERENCES catalogos.cliente("id"),
  ADD CONSTRAINT "despacho_bodega_id_fkey" FOREIGN KEY ("bodega_id") REFERENCES catalogos.bodega("id"),
  ADD CONSTRAINT "despacho_rechazado_por_fkey" FOREIGN KEY ("rechazado_por") REFERENCES identidad.usuario("id"),
  ADD CONSTRAINT "despacho_textos_check" CHECK (
    ("nota_solicitud" IS NULL OR length(btrim("nota_solicitud")) > 0)
    AND ("nota_bodega" IS NULL OR length(btrim("nota_bodega")) > 0)
    AND ("referencia_as2" IS NULL OR length(btrim("referencia_as2")) > 0)
  ),
  -- solicitado = nada resuelto; realizado = quién, cuándo y el respaldo; rechazado = quién, cuándo y el motivo (y nada del despacho)
  ADD CONSTRAINT "despacho_estado_check" CHECK (
    ("estado" = 'solicitado'
      AND num_nonnulls("realizado_at", "realizado_por", "archivo_respaldo_id", "archivo_msds_id", "referencia_as2",
                       "rechazado_at", "rechazado_por", "motivo_rechazo") = 0)
    OR ("estado" = 'realizado'
      AND num_nonnulls("realizado_at", "realizado_por", "archivo_respaldo_id") = 3
      AND num_nonnulls("rechazado_at", "rechazado_por", "motivo_rechazo") = 0)
    OR ("estado" = 'rechazado'
      AND num_nonnulls("rechazado_at", "rechazado_por") = 2
      AND length(btrim(coalesce("motivo_rechazo", ''))) > 0
      AND num_nonnulls("realizado_at", "realizado_por", "archivo_respaldo_id", "archivo_msds_id", "referencia_as2") = 0)
  );
-- una sola solicitud pendiente por pedido
CREATE UNIQUE INDEX "despacho_pedido_pendiente_key" ON "inventario"."despacho"("pedido_id") WHERE "estado" = 'solicitado';
CREATE INDEX "despacho_pedido_id_idx" ON "inventario"."despacho"("pedido_id");

-- Ítems pedidos: el texto (código, descripción) es la foto de lo que se pidió desde la lista de precios del cliente (otro
-- contenedor); el artículo de Inventario se enlaza con FK cuando el código coincide
CREATE TABLE "inventario"."despacho_item" (
  "id" UUID NOT NULL,
  "despacho_id" UUID NOT NULL,
  "orden" SMALLINT NOT NULL,
  "lista_precios_item_id" UUID,
  "codigo" TEXT NOT NULL,
  "descripcion" TEXT NOT NULL,
  "cantidad" DECIMAL(14,3) NOT NULL,
  "unidad_medida_id" UUID NOT NULL,
  "tipo" "inventario"."tipo_item_despacho" NOT NULL,
  "articulo_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_by" UUID NOT NULL,
  CONSTRAINT "despacho_item_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "despacho_item_despacho_id_fkey" FOREIGN KEY ("despacho_id") REFERENCES "inventario"."despacho"("id"),
  CONSTRAINT "despacho_item_unidad_medida_id_fkey" FOREIGN KEY ("unidad_medida_id") REFERENCES catalogos.unidad_medida("id"),
  CONSTRAINT "despacho_item_articulo_id_fkey" FOREIGN KEY ("articulo_id") REFERENCES "inventario"."articulo"("id"),
  CONSTRAINT "despacho_item_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario("id"),
  CONSTRAINT "despacho_item_cantidad_check" CHECK ("cantidad" > 0),
  CONSTRAINT "despacho_item_textos_check" CHECK (length(btrim("codigo")) > 0 AND length(btrim("descripcion")) > 0),
  CONSTRAINT "despacho_item_orden_key" UNIQUE ("despacho_id", "orden")
);
CREATE INDEX "despacho_item_articulo_id_idx" ON "inventario"."despacho_item"("articulo_id");
-- los ítems se registran al crear la solicitud y no cambian: la aplicación solo los lee e inserta (como el kardex)
GRANT SELECT, INSERT ON "inventario"."despacho_item" TO app_operaciones;
REVOKE UPDATE, DELETE ON "inventario"."despacho_item" FROM app_operaciones;

-- Una solicitud resuelta no cambia (ni con su propio rol: lo impide la base)
CREATE FUNCTION "inventario"."despacho_resuelto_inmutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."estado" <> 'solicitado' THEN
    RAISE EXCEPTION 'El despacho % ya fue resuelto (%): no se modifica', OLD."numero", OLD."estado";
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "despacho_resuelto_inmutable" BEFORE UPDATE ON "inventario"."despacho"
  FOR EACH ROW EXECUTE FUNCTION "inventario"."despacho_resuelto_inmutable"();
REVOKE DELETE ON "inventario"."despacho" FROM app_operaciones;

COMMENT ON TABLE "inventario"."despacho" IS 'Solicitud de despacho a bodega (CM-5): la pide Comercial con la prefactura generada (evento comercial.despacho.solicitado) y Bodega la despacha con su respaldo o la rechaza con motivo; el resultado vuelve a Comercial por evento. Una pendiente por pedido; resuelta, no cambia.';
COMMENT ON COLUMN "inventario"."despacho"."pedido_id" IS 'Pedido de comercial (otro contenedor): uuid sin FK (D1).';
COMMENT ON COLUMN "inventario"."despacho"."pedido_codigo" IS 'Código del pedido de comercial (otro contenedor), copiado para la bandeja de Bodega, que no tiene acceso a los pedidos.';
COMMENT ON COLUMN "inventario"."despacho"."referencia_as2" IS 'Número de la «Orden Salida Material» de AS2 que respalda el despacho (opcional).';
COMMENT ON COLUMN "inventario"."despacho_item"."lista_precios_item_id" IS 'Ítem de la lista de precios del cliente en comercial (otro contenedor): uuid sin FK.';
COMMENT ON COLUMN "inventario"."despacho_item"."articulo_id" IS 'Artículo de Inventario con el mismo código (o equivalencia), si existe: con él Bodega registra la salida de stock.';
