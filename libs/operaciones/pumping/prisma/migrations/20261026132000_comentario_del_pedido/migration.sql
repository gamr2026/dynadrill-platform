-- Auditoría de la base (26/10/2026): referencia a otro contenedor, sin FK a propósito (D1).
COMMENT ON COLUMN "ticket"."pedido_id" IS 'Pedido de comercial (otro contenedor, D1): uuid sin FK; un ticket por pedido.';
