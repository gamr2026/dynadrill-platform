-- Origen nuevo del kardex: lo que vuelve a bodega porque se anuló el pedido del ticket (la registra el sistema, no una persona). Va solo en esta
-- migración porque PostgreSQL no deja usar un valor de enum en la misma transacción en que se agrega; la migración siguiente lo usa.
ALTER TYPE "inventario"."origen_movimiento" ADD VALUE 'devolucion_anulacion';
