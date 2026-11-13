-- Bodega del pedido en el ticket (FK a catalogos.bodega). Llega con `comercial.pedido.abierto` / `actualizado` y sale en los eventos del ticket
-- para que QHSE prellene con ella la entrega de EPI.
ALTER TABLE "pumping"."ticket"
  ADD COLUMN "bodega_id" UUID,
  ADD CONSTRAINT "ticket_bodega_id_fkey" FOREIGN KEY ("bodega_id") REFERENCES catalogos.bodega ("id");

COMMENT ON COLUMN "pumping"."ticket"."bodega_id" IS 'Bodega del pedido (catalogos.bodega), tal como se abrió o se actualizó. QHSE la usa para prellenar la entrega de EPI.';

-- Tickets que ya existían: toman la bodega de su pedido (solo si el esquema de comercial existe en esta base).
DO $$
BEGIN
  IF to_regclass('comercial.pedido') IS NOT NULL THEN
    UPDATE "pumping"."ticket" t SET "bodega_id" = p."bodega_id"
      FROM comercial.pedido p WHERE p."id" = t."pedido_id" AND p."bodega_id" IS NOT NULL;
  END IF;
END $$;
