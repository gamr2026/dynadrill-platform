-- IN4: mínimos de stock por artículo y bodega. Decisión provisional mientras Dynadrill no responde la consulta IN4 (si Bodega quiere un
-- mínimo por artículo y por bodega, y a quién se avisa): es la granularidad más fina y sirve también para quien lo quiera general
-- (basta fijar el mismo valor en cada bodega). El aviso a personas se agrega cuando se confirme a quién.

CREATE TABLE "inventario"."stock_minimo" (
    "id" UUID NOT NULL,
    "articulo_id" UUID NOT NULL,
    "bodega_id" UUID NOT NULL,
    "minimo" NUMERIC(14,3) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID NOT NULL,
    CONSTRAINT "stock_minimo_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "stock_minimo_articulo_fkey" FOREIGN KEY ("articulo_id") REFERENCES "inventario"."articulo" ("id"),
    CONSTRAINT "stock_minimo_bodega_fkey" FOREIGN KEY ("bodega_id") REFERENCES catalogos.bodega ("id"),
    CONSTRAINT "stock_minimo_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "stock_minimo_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id"),
    -- un mínimo de cero no avisaría nunca (el saldo no baja de cero): para no tener mínimo se quita la fila
    CONSTRAINT "stock_minimo_minimo_check" CHECK ("minimo" > 0)
);
-- un solo mínimo por artículo y bodega
CREATE UNIQUE INDEX "stock_minimo_articulo_bodega_key" ON "inventario"."stock_minimo" ("articulo_id", "bodega_id");
CREATE INDEX "stock_minimo_bodega_idx" ON "inventario"."stock_minimo" ("bodega_id");
-- es una configuración, no historia: quitar un mínimo se permite (el kardex sigue intacto)
GRANT DELETE ON "inventario"."stock_minimo" TO app_operaciones;
COMMENT ON TABLE "inventario"."stock_minimo" IS 'Mínimo de existencias de un artículo en una bodega (consulta IN4, decisión provisional). Cuando una salida deja el saldo por debajo, se publica operaciones.inventario.stock.bajo_minimo una sola vez (al cruzar el mínimo hacia abajo).';
COMMENT ON COLUMN "inventario"."stock_minimo"."minimo" IS 'Existencia mínima deseada (mayor que cero). El saldo sale del kardex: aquí no se guarda.';
