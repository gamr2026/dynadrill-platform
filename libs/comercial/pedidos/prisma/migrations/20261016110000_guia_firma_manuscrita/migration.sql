-- Lectura de la firma manuscrita del archivo firmado de la guía (mismo enum que la prefactura).
ALTER TABLE "guia_remision"
  ADD COLUMN "firma_manuscrita" "verificacion_firma" NOT NULL DEFAULT 'no_verificada',
  ADD COLUMN "firma_manuscrita_confianza" DECIMAL(4,3),
  ADD COLUMN "firma_manuscrita_at" TIMESTAMPTZ(6);
