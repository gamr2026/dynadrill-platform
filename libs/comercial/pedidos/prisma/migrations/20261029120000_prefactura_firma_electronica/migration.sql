-- Validación de la firma electrónica (digital) del documento firmado de la prefactura, igual que la de la guía de remisión.
ALTER TABLE "prefactura_firma"
  ADD COLUMN "firma_electronica_estado" "estado_firma_electronica",
  ADD COLUMN "firma_electronica_resumen" TEXT,
  ADD COLUMN "firma_electronica_at" TIMESTAMPTZ(6);

CREATE TABLE "prefactura_firma_digital" (
    "id" UUID NOT NULL,
    "prefactura_firma_id" UUID NOT NULL,
    "orden" INTEGER NOT NULL,
    "firmante_nombre" TEXT,
    "firmante_identificacion" TEXT,
    "emisor" TEXT,
    "integridad" "integridad_firma_digital" NOT NULL,
    "firma_valida" BOOLEAN NOT NULL,
    "firmante_verificado" BOOLEAN NOT NULL,
    "vigente_al_firmar" BOOLEAN,
    "fecha_firma" TIMESTAMPTZ(6),
    "origen_fecha" "origen_fecha_firma" NOT NULL,
    "conclusion" TEXT NOT NULL,
    CONSTRAINT "prefactura_firma_digital_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "prefactura_firma_digital_prefactura_firma_id_orden_key" ON "prefactura_firma_digital"("prefactura_firma_id", "orden");
ALTER TABLE "prefactura_firma_digital" ADD CONSTRAINT "prefactura_firma_digital_prefactura_firma_id_fkey" FOREIGN KEY ("prefactura_firma_id") REFERENCES "prefactura_firma"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "prefactura_firma" ADD CONSTRAINT "prefactura_firma_firma_electronica_check"
  CHECK (("firma_electronica_estado" IS NULL) = ("firma_electronica_at" IS NULL));

-- El servicio reemplaza el resultado de la validación (borra y vuelve a crear las firmas digitales de esa firma).
GRANT DELETE ON "prefactura_firma_digital" TO app_comercial;

COMMENT ON TABLE comercial.prefactura_firma_digital IS 'Una firma digital encontrada en el documento firmado de la prefactura.';
