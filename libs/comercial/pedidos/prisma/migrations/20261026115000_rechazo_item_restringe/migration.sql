-- Auditoría de la base (26/10/2026): los ítems observados del rechazo son historia inmutable; no deben borrarse en cascada si se borra el ítem de la
-- prefactura (la aplicación sí puede borrar ítems al recalcular una prefactura recién generada, que nunca tiene observaciones).
ALTER TABLE "prefactura_rechazo_item" DROP CONSTRAINT "prefactura_rechazo_item_item_fkey";
ALTER TABLE "prefactura_rechazo_item" ADD CONSTRAINT "prefactura_rechazo_item_item_fkey"
  FOREIGN KEY ("prefactura_item_id", "prefactura_id") REFERENCES "prefactura_item" ("id", "prefactura_id") ON DELETE RESTRICT;
