-- OP-2 (PARIDAD-MODELO-DEMO.md): quién corrigió un día de la Bitácora. La demo guarda quién (y con qué rol) modificó un día enviado; la base solo
-- tenía `corregida_at`. El rol no se guarda: es el del usuario (identidad.usuario). Los días corregidos antes toman al último que los editó.
ALTER TABLE "bitacora_dia" ADD COLUMN "corregida_por" UUID;
UPDATE "bitacora_dia" SET "corregida_por" = "updated_by" WHERE "corregida_at" IS NOT NULL;
ALTER TABLE "bitacora_dia"
  ADD CONSTRAINT "bitacora_dia_corregida_por_fkey" FOREIGN KEY ("corregida_por") REFERENCES identidad.usuario ("id"),
  ADD CONSTRAINT "bitacora_dia_corregida_check" CHECK (("corregida_at" IS NULL) = ("corregida_por" IS NULL));
COMMENT ON COLUMN "bitacora_dia"."corregida_por" IS 'Quién corrigió el día en el pedido (el actor del evento de Comercial); su rol es el de su usuario.';
