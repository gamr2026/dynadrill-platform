-- Bodega del pedido en la réplica de tickets de QHSE (FK a catalogos.bodega): llega en los eventos de ticket de Pumping y de FCR
-- (`ticket_creado`, `asignacion_realizada`, campo `bodegaId`) y prellena la bodega de la entrega de EPI.
ALTER TABLE "qhse"."ticket_ref"
  ADD COLUMN "bodega_id" UUID,
  ADD CONSTRAINT "ticket_ref_bodega_id_fkey" FOREIGN KEY ("bodega_id") REFERENCES catalogos.bodega ("id");

COMMENT ON COLUMN "qhse"."ticket_ref"."bodega_id" IS 'COPIA justificada: bodega del pedido (catalogos.bodega), por la misma razón que cliente, campo y pozo. Se mantiene por evento; prellena la bodega de la entrega de EPI.';

-- Tickets que ya existían: toman la bodega de su pedido (solo si el esquema de comercial existe en esta base).
DO $$
BEGIN
  IF to_regclass('comercial.pedido') IS NOT NULL THEN
    UPDATE "qhse"."ticket_ref" t SET "bodega_id" = p."bodega_id"
      FROM comercial.pedido p WHERE p."id" = t."pedido_id" AND p."bodega_id" IS NOT NULL;
  END IF;
END $$;
