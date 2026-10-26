-- CM-5 (PARIDAD-MODELO-DEMO.md): la solicitud de despacho a bodega vive solo en Inventario (`inventario.despacho`, su dueño:
-- Bodega la resuelve). Comercial la pide (evento `comercial.despacho.solicitado`) y solo lleva el estado del pedido
-- (`por_despachar_bodega`); el resultado le llega por `operaciones.inventario.despacho.realizado|rechazado`. Las columnas del
-- pedido que copiaban quién solicitó, quién despachó y los archivos se retiran: el dato tenía dos lugares.
ALTER TABLE "comercial"."pedido" DROP CONSTRAINT "pedido_despacho_check";
ALTER TABLE "comercial"."pedido"
  DROP COLUMN "despacho_solicitado_at",
  DROP COLUMN "despacho_solicitado_por",
  DROP COLUMN "despacho_realizado_at",
  DROP COLUMN "despacho_realizado_por",
  DROP COLUMN "despacho_archivo_respaldo_id",
  DROP COLUMN "despacho_archivo_msds_id";

-- el regreso a la etapa de prefactura ahora lo dispara Inventario (despachado o rechazado)
UPDATE "comercial"."proceso_transicion"
   SET "evento_disparador" = 'operaciones.inventario.despacho.realizado|rechazado'
 WHERE "proceso" = 'pedido' AND "estado_origen" = 'por_despachar_bodega' AND "estado_destino" = 'prefactura_generada';
