-- Inventario (I1): catálogo de artículos y kardex inmutable. Schema: inventario.
-- Ids UUIDv7 generados por la aplicación (sin DEFAULT). El stock NUNCA se guarda: se calcula del kardex.

-- Lo que este módulo lee de otros schemas (mínimo necesario).
GRANT USAGE ON SCHEMA catalogos, identidad TO app_operaciones;
GRANT SELECT ON catalogos.bodega TO app_operaciones;
GRANT SELECT (id, nombre, email, activo, rol_id) ON identidad.usuario TO app_operaciones;
GRANT SELECT (id, codigo, nombre) ON identidad.rol TO app_operaciones;

-- Valores fijos
CREATE TYPE "tipo_movimiento" AS ENUM ('entrada', 'salida');
CREATE TYPE "origen_movimiento" AS ENUM (
    'saldo_inicial', 'compra', 'ajuste', 'despacho_bodega', 'salida_ticket', 'devolucion_ticket'
);
CREATE TYPE "tipo_codigo_articulo" AS ENUM ('alterno', 'comercial', 'barras');

-- Catálogos
CREATE TABLE "categoria_articulo" (
    "id" UUID NOT NULL,
    "nombre" TEXT NOT NULL,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    CONSTRAINT "categoria_articulo_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "categoria_articulo_nombre_key" ON "categoria_articulo"("nombre");

CREATE TABLE "subcategoria_articulo" (
    "id" UUID NOT NULL,
    "categoria_id" UUID NOT NULL,
    "nombre" TEXT NOT NULL,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    CONSTRAINT "subcategoria_articulo_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "subcategoria_articulo_categoria_id_nombre_key" ON "subcategoria_articulo"("categoria_id", "nombre");
-- permite que el artículo apunte a (subcategoría, categoría) y que la base garantice que la subcategoría es de esa categoría
CREATE UNIQUE INDEX "subcategoria_articulo_id_categoria_id_key" ON "subcategoria_articulo"("id", "categoria_id");
ALTER TABLE "subcategoria_articulo" ADD CONSTRAINT "subcategoria_articulo_categoria_id_fkey"
    FOREIGN KEY ("categoria_id") REFERENCES "categoria_articulo"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "unidad_stock" (
    "id" UUID NOT NULL,
    "nombre" TEXT NOT NULL,
    "simbolo" TEXT NOT NULL,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    CONSTRAINT "unidad_stock_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "unidad_stock_nombre_key" ON "unidad_stock"("nombre");

-- El motivo fija el tipo y el origen del movimiento; `manual` indica si la pantalla permite elegirlo (los demás los registra el sistema).
CREATE TABLE "motivo_movimiento" (
    "id" UUID NOT NULL,
    "nombre" TEXT NOT NULL,
    "tipo" "tipo_movimiento" NOT NULL,
    "origen" "origen_movimiento" NOT NULL,
    "manual" BOOLEAN NOT NULL DEFAULT false,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    CONSTRAINT "motivo_movimiento_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "motivo_movimiento_nombre_key" ON "motivo_movimiento"("nombre");
ALTER TABLE "motivo_movimiento" ADD CONSTRAINT "motivo_movimiento_origen_tipo_check" CHECK (
    ("origen" IN ('saldo_inicial', 'compra', 'devolucion_ticket') AND "tipo" = 'entrada')
    OR ("origen" IN ('despacho_bodega', 'salida_ticket') AND "tipo" = 'salida')
    OR "origen" = 'ajuste'
);

-- Artículo
CREATE TABLE "articulo" (
    "id" UUID NOT NULL,
    "codigo" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "nombre_comercial" TEXT,
    "categoria_id" UUID NOT NULL,
    "subcategoria_id" UUID,
    "unidad_stock_id" UUID NOT NULL,
    "nota" TEXT,
    "informacion_adicional" TEXT,
    "costo_unitario" DECIMAL(14,4),
    "descuento_sugerido" DECIMAL(5,2),
    "as2_id" INTEGER,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    CONSTRAINT "articulo_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "articulo_codigo_key" ON "articulo"("codigo");
CREATE UNIQUE INDEX "articulo_as2_id_key" ON "articulo"("as2_id");
CREATE INDEX "articulo_categoria_id_idx" ON "articulo"("categoria_id");
CREATE INDEX "articulo_subcategoria_id_idx" ON "articulo"("subcategoria_id");
ALTER TABLE "articulo" ADD CONSTRAINT "articulo_categoria_id_fkey"
    FOREIGN KEY ("categoria_id") REFERENCES "categoria_articulo"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "articulo" ADD CONSTRAINT "articulo_subcategoria_id_fkey"
    FOREIGN KEY ("subcategoria_id") REFERENCES "subcategoria_articulo"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- la subcategoría pertenece a la categoría del artículo (si no hay subcategoría, esta FK no se evalúa)
ALTER TABLE "articulo" ADD CONSTRAINT "articulo_subcategoria_categoria_fkey"
    FOREIGN KEY ("subcategoria_id", "categoria_id") REFERENCES "subcategoria_articulo"("id", "categoria_id");
ALTER TABLE "articulo" ADD CONSTRAINT "articulo_unidad_stock_id_fkey"
    FOREIGN KEY ("unidad_stock_id") REFERENCES "unidad_stock"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "articulo" ADD CONSTRAINT "articulo_costo_check" CHECK ("costo_unitario" IS NULL OR "costo_unitario" >= 0);
ALTER TABLE "articulo" ADD CONSTRAINT "articulo_descuento_check"
    CHECK ("descuento_sugerido" IS NULL OR ("descuento_sugerido" >= 0 AND "descuento_sugerido" <= 100));

-- Códigos alternos, comerciales y de barras (uno por tipo y artículo)
CREATE TABLE "articulo_codigo" (
    "id" UUID NOT NULL,
    "articulo_id" UUID NOT NULL,
    "tipo" "tipo_codigo_articulo" NOT NULL,
    "codigo" TEXT NOT NULL,
    CONSTRAINT "articulo_codigo_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "articulo_codigo_articulo_id_tipo_key" ON "articulo_codigo"("articulo_id", "tipo");
CREATE INDEX "articulo_codigo_codigo_idx" ON "articulo_codigo"("codigo");
ALTER TABLE "articulo_codigo" ADD CONSTRAINT "articulo_codigo_articulo_id_fkey"
    FOREIGN KEY ("articulo_id") REFERENCES "articulo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Partes de una herramienta (lista de componentes). `orden` lo asigna el servidor.
CREATE TABLE "articulo_parte" (
    "id" UUID NOT NULL,
    "articulo_id" UUID NOT NULL,
    "orden" INTEGER NOT NULL,
    "item" TEXT NOT NULL,
    "codigo" TEXT NOT NULL,
    "descripcion" TEXT NOT NULL,
    "cantidad_esperada" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    CONSTRAINT "articulo_parte_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "articulo_parte_articulo_id_orden_key" ON "articulo_parte"("articulo_id", "orden");
ALTER TABLE "articulo_parte" ADD CONSTRAINT "articulo_parte_articulo_id_fkey"
    FOREIGN KEY ("articulo_id") REFERENCES "articulo"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "articulo_parte" ADD CONSTRAINT "articulo_parte_cantidad_check" CHECK ("cantidad_esperada" > 0);
ALTER TABLE "articulo_parte" ADD CONSTRAINT "articulo_parte_orden_check" CHECK ("orden" > 0);

-- Kardex: un renglón por movimiento. INMUTABLE (ver REVOKE al final). `secuencia` da el orden estricto del kardex;
-- `saldo_resultante` es el saldo del artículo EN ESA BODEGA justo después del movimiento.
-- `pedido_id` y `ticket_id` son referencias a datos de negocio de otros módulos/contenedores (pedido de comercial; ticket de
-- Pumping o FCR): uuid sin FK (D1); el módulo dueño del ticket guarda el vínculo con FK hacia su lado.
CREATE TABLE "movimiento" (
    "id" UUID NOT NULL,
    "secuencia" BIGINT GENERATED ALWAYS AS IDENTITY,
    "articulo_id" UUID NOT NULL,
    "bodega_id" UUID NOT NULL,
    "tipo" "tipo_movimiento" NOT NULL,
    "origen" "origen_movimiento" NOT NULL,
    "motivo_id" UUID NOT NULL,
    "cantidad" DECIMAL(14,3) NOT NULL,
    "saldo_resultante" DECIMAL(14,3) NOT NULL,
    "fecha" TIMESTAMPTZ(6) NOT NULL,
    "observacion" TEXT,
    "responsable_id" UUID NOT NULL,
    "pedido_id" UUID,
    "ticket_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "movimiento_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "movimiento_secuencia_key" ON "movimiento"("secuencia");
CREATE INDEX "movimiento_articulo_id_bodega_id_secuencia_idx" ON "movimiento"("articulo_id", "bodega_id", "secuencia");
CREATE INDEX "movimiento_ticket_id_idx" ON "movimiento"("ticket_id");
CREATE INDEX "movimiento_pedido_id_idx" ON "movimiento"("pedido_id");
CREATE INDEX "movimiento_fecha_idx" ON "movimiento"("fecha");
ALTER TABLE "movimiento" ADD CONSTRAINT "movimiento_articulo_id_fkey"
    FOREIGN KEY ("articulo_id") REFERENCES "articulo"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "movimiento" ADD CONSTRAINT "movimiento_bodega_id_fkey"
    FOREIGN KEY ("bodega_id") REFERENCES catalogos.bodega("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "movimiento" ADD CONSTRAINT "movimiento_motivo_id_fkey"
    FOREIGN KEY ("motivo_id") REFERENCES "motivo_movimiento"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "movimiento" ADD CONSTRAINT "movimiento_responsable_id_fkey"
    FOREIGN KEY ("responsable_id") REFERENCES identidad.usuario("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "movimiento" ADD CONSTRAINT "movimiento_cantidad_check" CHECK ("cantidad" > 0);
ALTER TABLE "movimiento" ADD CONSTRAINT "movimiento_saldo_check" CHECK ("saldo_resultante" >= 0);
ALTER TABLE "movimiento" ADD CONSTRAINT "movimiento_origen_tipo_check" CHECK (
    ("origen" IN ('saldo_inicial', 'compra', 'devolucion_ticket') AND "tipo" = 'entrada')
    OR ("origen" IN ('despacho_bodega', 'salida_ticket') AND "tipo" = 'salida')
    OR "origen" = 'ajuste'
);
ALTER TABLE "movimiento" ADD CONSTRAINT "movimiento_referencia_check" CHECK (
    ("origen" NOT IN ('salida_ticket', 'devolucion_ticket') OR "ticket_id" IS NOT NULL)
    AND ("origen" <> 'despacho_bodega' OR "pedido_id" IS NOT NULL)
);

-- Auditoría: quién creó o cambió cada registro (FK a la cuenta)
ALTER TABLE "categoria_articulo"
    ADD CONSTRAINT "categoria_articulo_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario("id"),
    ADD CONSTRAINT "categoria_articulo_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario("id");
ALTER TABLE "subcategoria_articulo"
    ADD CONSTRAINT "subcategoria_articulo_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario("id"),
    ADD CONSTRAINT "subcategoria_articulo_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario("id");
ALTER TABLE "unidad_stock"
    ADD CONSTRAINT "unidad_stock_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario("id"),
    ADD CONSTRAINT "unidad_stock_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario("id");
ALTER TABLE "motivo_movimiento"
    ADD CONSTRAINT "motivo_movimiento_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario("id"),
    ADD CONSTRAINT "motivo_movimiento_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario("id");
ALTER TABLE "articulo"
    ADD CONSTRAINT "articulo_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario("id"),
    ADD CONSTRAINT "articulo_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario("id");
ALTER TABLE "articulo_parte"
    ADD CONSTRAINT "articulo_parte_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario("id"),
    ADD CONSTRAINT "articulo_parte_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario("id");

-- El kardex no se corrige: un error se corrige con otro movimiento (ajuste). La aplicación no puede modificar ni borrar un renglón.
REVOKE UPDATE, DELETE ON "movimiento" FROM app_operaciones;
-- Quitar una parte o un código sí está permitido (no son historia).
GRANT DELETE ON "articulo_parte", "articulo_codigo" TO app_operaciones;

COMMENT ON TABLE "articulo" IS 'Artículo de bodega (herramientas, químicos e insumos). El stock se calcula del kardex; as2_id enlaza con el producto de AS2 cuando AS2 lo exponga.';
COMMENT ON TABLE "movimiento" IS 'Kardex inmutable: un renglón por movimiento y bodega, con el saldo resultante. Sin UPDATE ni DELETE para la aplicación.';
COMMENT ON COLUMN "movimiento"."pedido_id" IS 'Pedido de comercial (otro contenedor): uuid sin FK.';
COMMENT ON COLUMN "movimiento"."ticket_id" IS 'Ticket de Pumping o FCR: uuid sin FK; el módulo del ticket guarda el vínculo hacia este movimiento.';
