-- C8 de plan-comercial-ajustes: al realizar el despacho, Bodega adjunta el documento de respaldo (obligatorio, lo exige
-- el servicio) y, si despacha químicos, la hoja MSDS (opcional). Ambos son archivos reales (FK a archivos.archivo).
ALTER TABLE "pedido"
  ADD COLUMN "despacho_archivo_respaldo_id" UUID,
  ADD COLUMN "despacho_archivo_msds_id" UUID,
  ADD CONSTRAINT "pedido_despacho_archivo_respaldo_id_fkey" FOREIGN KEY ("despacho_archivo_respaldo_id") REFERENCES archivos.archivo ("id"),
  ADD CONSTRAINT "pedido_despacho_archivo_msds_id_fkey" FOREIGN KEY ("despacho_archivo_msds_id") REFERENCES archivos.archivo ("id");
