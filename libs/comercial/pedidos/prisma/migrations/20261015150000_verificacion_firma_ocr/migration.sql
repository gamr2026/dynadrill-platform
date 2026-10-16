-- Resultado de la lectura automática de la firma (servicio firmas-ocr). Es una ayuda para revisar, nunca un bloqueo.
ALTER TYPE "verificacion_firma" ADD VALUE IF NOT EXISTS 'no_concluyente';
ALTER TABLE "prefactura_firma"
  ADD COLUMN "verificacion_confianza" DECIMAL(4,3),
  ADD COLUMN "verificacion_at" TIMESTAMPTZ(6),
  ADD COLUMN "nombre_coincide" BOOLEAN;
ALTER TABLE "prefactura_firma" ADD CONSTRAINT "prefactura_firma_confianza_check"
  CHECK ("verificacion_confianza" IS NULL OR ("verificacion_confianza" >= 0 AND "verificacion_confianza" <= 1));
