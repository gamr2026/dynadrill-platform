-- Guía de remisión (con su numeración del portal) y las dos marcas de despacho a Bodega.
CREATE TYPE "estado_guia" AS ENUM ('emitida', 'anulada');
CREATE TYPE "origen_item_guia" AS ENUM ('herramienta', 'material', 'manual');

CREATE TABLE "lugar_despacho" (
    "id" UUID NOT NULL,
    "nombre" TEXT NOT NULL,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "lugar_despacho_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "lugar_despacho_nombre_key" ON "lugar_despacho"("nombre");

CREATE TABLE "guia_remision" (
    "id" UUID NOT NULL,
    "pedido_id" UUID NOT NULL,
    "numero" INTEGER NOT NULL,
    "codigo" TEXT NOT NULL,
    "emision_id" UUID NOT NULL,
    "estado" "estado_guia" NOT NULL DEFAULT 'emitida',
    "fecha" DATE NOT NULL,
    "cliente_nombre" TEXT,
    "cliente_ruc" TEXT,
    "lugar_origen_id" UUID NOT NULL,
    "solicitado_por_id" UUID,
    "solicitado_por_nombre" TEXT,
    "despachado_por_id" UUID,
    "despachado_por_nombre" TEXT,
    "hora_salida" TEXT,
    "hora_llegada" TEXT,
    "transportista_id" UUID NOT NULL,
    "transportista_nombre" TEXT NOT NULL,
    "transportista_identificacion" TEXT NOT NULL,
    "vehiculo_id" UUID,
    "placa" TEXT,
    "chofer_id" UUID,
    "chofer_nombre" TEXT,
    "observaciones" TEXT,
    "reemplaza_a_id" UUID,
    "emitida_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "emitida_por" UUID NOT NULL,
    "anulada_at" TIMESTAMPTZ(6),
    "anulada_por" UUID,
    "anulacion_motivo" TEXT,
    "archivo_firmado_id" UUID,
    "archivo_firmado_nombre" TEXT,
    "firmada_at" TIMESTAMPTZ(6),
    CONSTRAINT "guia_remision_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "guia_remision_codigo_key" ON "guia_remision"("codigo");
CREATE INDEX "guia_remision_pedido_id_idx" ON "guia_remision"("pedido_id");
ALTER TABLE "guia_remision" ADD CONSTRAINT "guia_remision_pedido_id_fkey" FOREIGN KEY ("pedido_id") REFERENCES "pedido"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "guia_remision" ADD CONSTRAINT "guia_remision_lugar_origen_id_fkey" FOREIGN KEY ("lugar_origen_id") REFERENCES "lugar_despacho"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "guia_remision" ADD CONSTRAINT "guia_remision_reemplaza_a_id_fkey" FOREIGN KEY ("reemplaza_a_id") REFERENCES "guia_remision"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "guia_remision" ADD CONSTRAINT "guia_remision_numero_check" CHECK ("numero" > 0);
ALTER TABLE "guia_remision" ADD CONSTRAINT "guia_remision_horas_check"
  CHECK (("hora_salida" IS NULL OR "hora_salida" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$') AND ("hora_llegada" IS NULL OR "hora_llegada" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'));
ALTER TABLE "guia_remision" ADD CONSTRAINT "guia_remision_anulada_check"
  CHECK (("estado" = 'anulada') = ("anulada_at" IS NOT NULL) AND ("estado" <> 'anulada' OR "anulacion_motivo" IS NOT NULL));

CREATE TABLE "guia_remision_item" (
    "id" UUID NOT NULL,
    "guia_id" UUID NOT NULL,
    "orden" INTEGER NOT NULL,
    "codigo" TEXT,
    "descripcion" TEXT NOT NULL,
    "cantidad" DECIMAL(14,3) NOT NULL,
    "unidad" TEXT NOT NULL,
    "serie" TEXT,
    "origen" "origen_item_guia" NOT NULL,
    CONSTRAINT "guia_remision_item_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "guia_remision_item_guia_id_orden_key" ON "guia_remision_item"("guia_id", "orden");
ALTER TABLE "guia_remision_item" ADD CONSTRAINT "guia_remision_item_guia_id_fkey" FOREIGN KEY ("guia_id") REFERENCES "guia_remision"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "guia_remision_item" ADD CONSTRAINT "guia_remision_item_cantidad_check" CHECK ("cantidad" > 0);

-- Despacho a Bodega: dos marcas en el pedido (quién y cuándo), sin documento.
ALTER TABLE "pedido"
  ADD COLUMN "despacho_solicitado_at" TIMESTAMPTZ(6),
  ADD COLUMN "despacho_solicitado_por" UUID,
  ADD COLUMN "despacho_solicitado_nombre" TEXT,
  ADD COLUMN "despacho_realizado_at" TIMESTAMPTZ(6),
  ADD COLUMN "despacho_realizado_por" UUID,
  ADD COLUMN "despacho_realizado_nombre" TEXT;
ALTER TABLE "pedido" ADD CONSTRAINT "pedido_despacho_check"
  CHECK ("despacho_realizado_at" IS NULL OR "despacho_solicitado_at" IS NOT NULL);

COMMENT ON TABLE "guia_remision" IS 'Guía de remisión del pedido (lo que sale físicamente de bodega); numerada con el secuencial del portal.';
