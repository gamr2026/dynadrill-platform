-- Validación de la firma electrónica (digital) del PDF firmado de la guía de remisión.
CREATE TYPE "estado_firma_electronica" AS ENUM ('sin_firmas_digitales', 'verificado', 'verificado_con_advertencias', 'firmantes_no_verificados', 'alterado');
CREATE TYPE "integridad_firma_digital" AS ENUM ('intacto', 'intacto_con_revisiones_posteriores', 'modificado_despues_de_firmar', 'firma_invalida');
CREATE TYPE "origen_fecha_firma" AS ENUM ('sello_de_tiempo', 'declarada_por_el_firmante', 'desconocida');

ALTER TABLE "guia_remision"
  ADD COLUMN "firma_electronica_estado" "estado_firma_electronica",
  ADD COLUMN "firma_electronica_resumen" TEXT,
  ADD COLUMN "firma_electronica_at" TIMESTAMPTZ(6);

CREATE TABLE "guia_firma_digital" (
    "id" UUID NOT NULL,
    "guia_id" UUID NOT NULL,
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
    CONSTRAINT "guia_firma_digital_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "guia_firma_digital_guia_id_orden_key" ON "guia_firma_digital"("guia_id", "orden");
ALTER TABLE "guia_firma_digital" ADD CONSTRAINT "guia_firma_digital_guia_id_fkey" FOREIGN KEY ("guia_id") REFERENCES "guia_remision"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "guia_remision" ADD CONSTRAINT "guia_remision_firma_electronica_check"
  CHECK (("firma_electronica_estado" IS NULL) = ("firma_electronica_at" IS NULL));
