-- Anulación del ticket cuando se anula su pedido: el macro-estado `anulado` (no se reutiliza `rechazado`, que no tiene uso). El valor nuevo del enum va
-- solo en esta migración porque PostgreSQL no permite usarlo en la misma transacción en que se agrega; la siguiente lo usa.
ALTER TYPE "pumping"."macro_estado" ADD VALUE IF NOT EXISTS 'anulado';
