-- El cierre del pedido (control de costos, listo para facturar y número de factura) se retiró del aplicativo el 21/10/2026
-- (migración 20261021220000). Estas tres columnas del pedido quedaron sin ninguna lectura ni escritura; `facturado` sigue siendo un
-- estado final, que no necesita guardar la factura. Si algún día se vuelve a registrar la factura, se agrega con otra migración.
ALTER TABLE "pedido"
  DROP COLUMN "factura_numero",
  DROP COLUMN "facturado_at",
  DROP COLUMN "facturado_por";
