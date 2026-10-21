-- Los adjuntos referenciales de un pedido (solicitud, orden de compra, contrato) son PDF, imágenes u ofimática: 10 MB sobran y evitan
-- que se suban escaneos pesados. Los respaldos firmados (prefactura, guía, OT) conservan su tope.
UPDATE "archivos"."modulo_archivo" SET "tamano_max_mb" = 10 WHERE "codigo" = 'pedido_documento';
