-- Los despachos también los pide FCR: cuando el Supervisor solicita las herramientas de un ticket, Bodega recibe una solicitud en su bandeja de
-- despachos (junto a las de Facturación) para elaborar la guía de remisión. La solicitud de FCR puede no traer ítems de material: Bodega agrega
-- en la guía las herramientas en renta que faltan.
CREATE TYPE "inventario"."origen_despacho" AS ENUM ('facturacion', 'fcr');
ALTER TABLE "inventario"."despacho"
  ADD COLUMN "origen" "inventario"."origen_despacho" NOT NULL DEFAULT 'facturacion',
  ADD COLUMN "ticket_fcr_id" UUID,
  ADD COLUMN "ticket_fcr_numero" INTEGER;
ALTER TABLE "inventario"."despacho"
  ADD CONSTRAINT "despacho_origen_check" CHECK (("origen" = 'fcr') = ("ticket_fcr_id" IS NOT NULL));
CREATE INDEX "despacho_ticket_fcr_id_idx" ON "inventario"."despacho" ("ticket_fcr_id");
COMMENT ON COLUMN "inventario"."despacho"."origen" IS 'Quién pidió el despacho: Facturación (con la prefactura generada) o un ticket de FCR (al solicitar sus herramientas).';
