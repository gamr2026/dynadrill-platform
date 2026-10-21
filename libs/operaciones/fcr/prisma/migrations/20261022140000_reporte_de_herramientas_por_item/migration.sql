-- El Reporte de Herramientas (DYN-FCR-RE-008) se arma por ítem de la lista de precios del cliente, no por herramienta física: cada fila es un código
-- con su descripción y unidad, su serie y su cantidad real (marcas por día si la unidad es de tiempo; una cantidad escrita si no). De esa cantidad salen la
-- guía de remisión, la prefactura y la orden de trabajo. El stand-by no se cobra (no existe entre los estados del reporte).
CREATE TYPE "estado_item_reporte" AS ENUM ('operacion', 'daily_charge', 'venta');

CREATE TABLE "reporte_item" (
    "id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "orden" SMALLINT NOT NULL,
    -- copia imprescindible de la lista de precios (otro contenedor: sin FK) para imprimir el reporte
    "codigo" TEXT NOT NULL,
    "descripcion" TEXT NOT NULL,
    "unidad" TEXT,
    -- la unidad es de tiempo (día): se reporta con marcas por día
    "por_dia" BOOLEAN NOT NULL,
    "cantidad" NUMERIC(14,3),
    "serie" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID NOT NULL,
    CONSTRAINT "reporte_item_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "reporte_item_ticket_fkey" FOREIGN KEY ("ticket_id") REFERENCES "ticket" ("id") ON DELETE CASCADE,
    CONSTRAINT "reporte_item_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "reporte_item_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "reporte_item_codigo_check" CHECK (length(btrim("codigo")) > 0 AND length(btrim("descripcion")) > 0),
    CONSTRAINT "reporte_item_serie_check" CHECK ("serie" IS NULL OR length(btrim("serie")) > 0),
    -- por día: solo marcas; si no, la cantidad escrita (mayor que cero)
    CONSTRAINT "reporte_item_cantidad_check" CHECK (("por_dia" AND "cantidad" IS NULL) OR (NOT "por_dia" AND "cantidad" IS NOT NULL AND "cantidad" > 0))
);
CREATE UNIQUE INDEX "reporte_item_orden_key" ON "reporte_item" ("ticket_id", "orden");
-- el mismo código puede repetirse con series distintas (cada equipo es una fila), pero no dos veces con la misma serie
CREATE UNIQUE INDEX "reporte_item_codigo_serie_key" ON "reporte_item" ("ticket_id", "codigo", (COALESCE("serie", '')));
GRANT DELETE ON "reporte_item" TO app_operaciones;
COMMENT ON TABLE "reporte_item" IS 'Fila del Reporte de Herramientas: un código de la lista de precios del cliente con su serie y su cantidad real.';

CREATE TABLE "reporte_item_dia" (
    "id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "fecha" DATE NOT NULL,
    "estado" "estado_item_reporte" NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    CONSTRAINT "reporte_item_dia_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "reporte_item_dia_item_fkey" FOREIGN KEY ("item_id") REFERENCES "reporte_item" ("id") ON DELETE CASCADE,
    CONSTRAINT "reporte_item_dia_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id")
);
CREATE UNIQUE INDEX "reporte_item_dia_key" ON "reporte_item_dia" ("item_id", "fecha");
GRANT DELETE, UPDATE ON "reporte_item_dia" TO app_operaciones;
COMMENT ON TABLE "reporte_item_dia" IS 'Marca de un día de una fila por día del Reporte de Herramientas: operación (O), daily charge (D) o venta (V). Cada marca vale una unidad.';
