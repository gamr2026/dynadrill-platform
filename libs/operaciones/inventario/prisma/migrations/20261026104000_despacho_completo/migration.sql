-- CM-5 (PARIDAD-MODELO-DEMO.md): la solicitud de despacho a bodega queda completa y su dueño es Inventario (Bodega la resuelve).
-- Antes solo era un estado copiado de Comercial; ahora guarda lo que la demo guardaba: número, cliente, bodega de origen, fecha
-- requerida, nota de Ventas o Facturación, ítems pedidos, nota de Bodega, referencia de la «Orden Salida Material» de AS2 y el
-- rechazo con motivo. Puede haber varias por pedido (otra después de un rechazo), pero solo una pendiente. Una vez resuelta no cambia.
-- Los despachos parten de cero (indicación del usuario del 26/10/2026): la tabla está vacía.

CREATE TYPE "inventario"."tipo_item_despacho" AS ENUM ('material', 'herramienta');
ALTER TYPE "inventario"."estado_despacho" ADD VALUE 'rechazado';
