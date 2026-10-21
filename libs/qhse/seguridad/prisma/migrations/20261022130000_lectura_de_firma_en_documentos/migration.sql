-- D6 (21/10/2026): al cargar el documento firmado (formato de recepción, ART, PT, SFI y Acta de Entrega) se lee la firma con el OCR de plataforma y se guarda
-- solo el resultado como indicador (no certifica nada y nunca bloquea la carga). Es lo único que se actualiza de un documento además de su anulación.
CREATE TYPE "verificacion_firma" AS ENUM ('no_verificada', 'firma_detectada', 'firma_no_detectada', 'no_concluyente');
ALTER TABLE "documento_pedido"
  ADD COLUMN "verificacion" "verificacion_firma" NOT NULL DEFAULT 'no_verificada',
  ADD COLUMN "verificacion_confianza" DECIMAL(4,3),
  ADD COLUMN "verificacion_at" TIMESTAMPTZ(6);
ALTER TABLE "documento_pedido" ADD CONSTRAINT "documento_pedido_confianza_check"
  CHECK ("verificacion_confianza" IS NULL OR ("verificacion_confianza" >= 0 AND "verificacion_confianza" <= 1));
GRANT UPDATE ("verificacion", "verificacion_confianza", "verificacion_at") ON "documento_pedido" TO app_qhse;
