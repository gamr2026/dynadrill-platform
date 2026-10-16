-- Tipo de OT como catálogo, medio de solicitud como enum, y bodega / condición de pago por id de catálogo.

-- 1) Tipo de OT: catálogo con id
CREATE TABLE "tipo_ot" (
    "id" UUID NOT NULL,
    "codigo" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "orden" INTEGER NOT NULL DEFAULT 0,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "tipo_ot_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "tipo_ot_codigo_key" ON "tipo_ot"("codigo");
INSERT INTO "tipo_ot" ("id", "codigo", "nombre", "orden") VALUES
  (gen_random_uuid(), 'venta', 'Venta', 0),
  (gen_random_uuid(), 'servicio', 'Servicio', 1);

ALTER TABLE "pedido" ADD COLUMN "tipo_ot_id" UUID;
UPDATE "pedido" p SET "tipo_ot_id" = t."id" FROM "tipo_ot" t WHERE t."codigo" = p."tipo_ot";
ALTER TABLE "pedido" DROP CONSTRAINT "pedido_completo_check";
ALTER TABLE "pedido" DROP CONSTRAINT "pedido_tipo_ot_check";
ALTER TABLE "pedido" DROP COLUMN "tipo_ot";
ALTER TABLE "pedido" ADD CONSTRAINT "pedido_tipo_ot_id_fkey"
  FOREIGN KEY ("tipo_ot_id") REFERENCES "tipo_ot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pedido" ADD CONSTRAINT "pedido_completo_check" CHECK (
  "estado" IN ('borrador', 'anulado') OR (
    "codigo" IS NOT NULL AND "cliente_id" IS NOT NULL AND "linea_id" IS NOT NULL AND "tipo_ot_id" IS NOT NULL
    AND "campo_id" IS NOT NULL AND "pozo_id" IS NOT NULL AND ("rigless" OR "taladro_id" IS NOT NULL)
    AND "numero_contrato" IS NOT NULL AND "fecha_inicio_servicio" IS NOT NULL AND "fecha_fin_servicio" IS NOT NULL
    AND "agente_comercial_id" IS NOT NULL AND "tecnico_hse_id" IS NOT NULL
  )
);

-- 2) Medio de solicitud: enum
CREATE TYPE "solicitud_medio" AS ENUM ('verbal', 'escrita');
ALTER TABLE "pedido" DROP CONSTRAINT "pedido_solicitud_medio_check";
ALTER TABLE "pedido" ALTER COLUMN "solicitud_medio" TYPE "solicitud_medio" USING "solicitud_medio"::"solicitud_medio";

-- 3) Bodega y condición de pago: id del catálogo (catalogos.bodega / catalogos.condicion_pago; sin FK entre schemas)
ALTER TABLE "pedido" ADD COLUMN "bodega_id" UUID, ADD COLUMN "condicion_pago_id" UUID;

COMMENT ON TABLE "tipo_ot" IS 'Catálogo de tipos de OT (venta, servicio).';
