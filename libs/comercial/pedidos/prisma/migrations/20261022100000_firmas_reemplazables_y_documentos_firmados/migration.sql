-- 1) Reemplazar la prefactura firmada: la firma anterior se conserva (historia) y queda enlazada a la que la reemplaza.
ALTER TABLE "prefactura_firma" ADD COLUMN "reemplazada_por_id" UUID;
CREATE UNIQUE INDEX "prefactura_firma_reemplazada_por_id_key" ON "prefactura_firma"("reemplazada_por_id");
ALTER TABLE "prefactura_firma" ADD CONSTRAINT "prefactura_firma_reemplazada_por_id_fkey"
  FOREIGN KEY ("reemplazada_por_id") REFERENCES "prefactura_firma"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
COMMENT ON COLUMN "prefactura_firma"."reemplazada_por_id" IS 'La firma que sustituyó a esta (la vigente no tiene reemplazo).';

-- 2) Versión firmada de un documento de respaldo del ticket (monitoreo de un día o mezcla química), con la lectura automática de la firma.
CREATE TYPE "tipo_documento_respaldo" AS ENUM ('monitoreo', 'mezcla_quimica');
CREATE TABLE "documento_respaldo_firmado" (
    "id" UUID NOT NULL,
    "pedido_id" UUID NOT NULL,
    "tipo" "tipo_documento_respaldo" NOT NULL,
    /* el documento del ticket de Pumping al que corresponde (referencia por id: son contenedores distintos) */
    "documento_ticket_id" UUID NOT NULL,
    "fecha" DATE,
    "archivo_id" UUID NOT NULL,
    "verificacion" "verificacion_firma" NOT NULL DEFAULT 'no_verificada',
    "verificacion_confianza" DECIMAL(4,3),
    "verificacion_at" TIMESTAMPTZ(6),
    "registrado_por" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reemplazado_por_id" UUID,
    CONSTRAINT "documento_respaldo_firmado_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "documento_respaldo_firmado_confianza_check" CHECK ("verificacion_confianza" IS NULL OR ("verificacion_confianza" >= 0 AND "verificacion_confianza" <= 1)),
    CONSTRAINT "documento_respaldo_firmado_monitoreo_fecha_check" CHECK (("tipo" = 'monitoreo') = ("fecha" IS NOT NULL))
);
CREATE UNIQUE INDEX "documento_respaldo_firmado_reemplazado_por_id_key" ON "documento_respaldo_firmado"("reemplazado_por_id");
CREATE UNIQUE INDEX "documento_respaldo_firmado_pedido_id_archivo_id_key" ON "documento_respaldo_firmado"("pedido_id", "archivo_id");
CREATE INDEX "documento_respaldo_firmado_pedido_id_documento_ticket_id_idx" ON "documento_respaldo_firmado"("pedido_id", "documento_ticket_id");
ALTER TABLE "documento_respaldo_firmado"
  ADD CONSTRAINT "documento_respaldo_firmado_pedido_id_fkey" FOREIGN KEY ("pedido_id") REFERENCES "pedido"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "documento_respaldo_firmado_reemplazado_por_id_fkey" FOREIGN KEY ("reemplazado_por_id") REFERENCES "documento_respaldo_firmado"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "documento_respaldo_firmado_archivo_id_fkey" FOREIGN KEY ("archivo_id") REFERENCES archivos.archivo ("id"),
  ADD CONSTRAINT "documento_respaldo_firmado_registrado_por_fkey" FOREIGN KEY ("registrado_por") REFERENCES identidad.usuario ("id");
COMMENT ON TABLE "documento_respaldo_firmado" IS 'Versión firmada de un documento de respaldo del ticket (monitoreo o mezcla); la vigente no tiene reemplazo.';
