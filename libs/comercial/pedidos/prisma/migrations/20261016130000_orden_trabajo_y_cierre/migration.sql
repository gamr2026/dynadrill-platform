-- Orden de trabajo (OT) y cierre del pedido (factura de AS2).
ALTER TABLE "lista_precios"
  ADD COLUMN "requiere_orden_trabajo" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "texto_contrato" TEXT;
ALTER TABLE "pedido"
  ADD COLUMN "factura_numero" TEXT,
  ADD COLUMN "facturado_at" TIMESTAMPTZ(6),
  ADD COLUMN "facturado_por" UUID;

CREATE TYPE "estado_orden_trabajo" AS ENUM ('generada', 'firmada');

CREATE TABLE "ciudad_ot" (
    "id" UUID NOT NULL,
    "codigo" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "ciudad_ot_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ciudad_ot_codigo_key" ON "ciudad_ot"("codigo");

CREATE TABLE "firmante_contratista" (
    "id" UUID NOT NULL,
    "nombre" TEXT NOT NULL,
    "cargo" TEXT NOT NULL,
    "predeterminado" BOOLEAN NOT NULL DEFAULT false,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "firmante_contratista_pkey" PRIMARY KEY ("id")
);
-- un solo firmante predeterminado
CREATE UNIQUE INDEX "firmante_contratista_predeterminado_key" ON "firmante_contratista"("predeterminado") WHERE "predeterminado";

CREATE TABLE "orden_trabajo" (
    "id" UUID NOT NULL,
    "pedido_id" UUID NOT NULL,
    "prefactura_id" UUID NOT NULL,
    "numero" INTEGER NOT NULL,
    "codigo" TEXT NOT NULL,
    "emision_id" UUID NOT NULL,
    "ciudad_id" UUID NOT NULL,
    "anio" SMALLINT NOT NULL,
    "fecha" DATE NOT NULL,
    "numero_contrato" TEXT,
    "texto_contrato" TEXT,
    "descripcion_requerimiento" TEXT NOT NULL,
    "servicio" TEXT NOT NULL,
    "fecha_inicio" DATE,
    "fecha_terminacion" DATE,
    "valor_ot" DECIMAL(14,2) NOT NULL,
    "contratista_nombre" TEXT NOT NULL,
    "contratista_cargo" TEXT NOT NULL,
    "cliente_nombre" TEXT NOT NULL,
    "cliente_cargo" TEXT NOT NULL,
    "estado" "estado_orden_trabajo" NOT NULL DEFAULT 'generada',
    "generada_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "generada_por" UUID NOT NULL,
    "firmada_at" TIMESTAMPTZ(6),
    "firmada_por" UUID,
    "archivo_firmado_id" UUID,
    "archivo_firmado_nombre" TEXT,
    CONSTRAINT "orden_trabajo_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "orden_trabajo_pedido_id_key" ON "orden_trabajo"("pedido_id");
CREATE UNIQUE INDEX "orden_trabajo_codigo_key" ON "orden_trabajo"("codigo");
ALTER TABLE "orden_trabajo" ADD CONSTRAINT "orden_trabajo_pedido_id_fkey" FOREIGN KEY ("pedido_id") REFERENCES "pedido"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "orden_trabajo" ADD CONSTRAINT "orden_trabajo_ciudad_id_fkey" FOREIGN KEY ("ciudad_id") REFERENCES "ciudad_ot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "orden_trabajo" ADD CONSTRAINT "orden_trabajo_numero_check" CHECK ("numero" > 0);
ALTER TABLE "orden_trabajo" ADD CONSTRAINT "orden_trabajo_firmada_check" CHECK (("estado" = 'firmada') = ("firmada_at" IS NOT NULL));

CREATE TABLE "orden_trabajo_item" (
    "id" UUID NOT NULL,
    "orden_id" UUID NOT NULL,
    "orden" INTEGER NOT NULL,
    "codigo" TEXT,
    "descripcion" TEXT NOT NULL,
    "unidad" TEXT,
    "tarifa" DECIMAL(14,2) NOT NULL,
    "cantidad" DECIMAL(14,3) NOT NULL,
    "total" DECIMAL(14,2) NOT NULL,
    CONSTRAINT "orden_trabajo_item_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "orden_trabajo_item_orden_id_orden_key" ON "orden_trabajo_item"("orden_id", "orden");
ALTER TABLE "orden_trabajo_item" ADD CONSTRAINT "orden_trabajo_item_orden_id_fkey" FOREIGN KEY ("orden_id") REFERENCES "orden_trabajo"("id") ON DELETE CASCADE ON UPDATE CASCADE;
