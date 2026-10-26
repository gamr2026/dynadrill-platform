-- OP-2 (PARIDAD-MODELO-DEMO.md), igual que la Bitácora de FCR: quién corrigió un día del Reporte Diario. Los días corregidos antes toman al
-- último que los editó.
ALTER TABLE "reporte_diario" ADD COLUMN "corregido_por" UUID;
UPDATE "reporte_diario" SET "corregido_por" = "updated_by" WHERE "corregido_at" IS NOT NULL;
ALTER TABLE "reporte_diario"
  ADD CONSTRAINT "reporte_diario_corregido_por_fkey" FOREIGN KEY ("corregido_por") REFERENCES identidad.usuario ("id"),
  ADD CONSTRAINT "reporte_diario_corregido_check" CHECK (("corregido_at" IS NULL) = ("corregido_por" IS NULL));
COMMENT ON COLUMN "reporte_diario"."corregido_por" IS 'Quién corrigió el día en el pedido (el actor del evento de Comercial); su rol es el de su usuario.';
