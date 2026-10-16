-- El ticket es la prefactura: el pedido toma su número del secuencial de la prefactura al abrirse, y la prefactura lo hereda.
ALTER TABLE "pedido"
  ADD COLUMN "ticket_numero" INTEGER,
  ADD COLUMN "ticket_emision_id" UUID;
CREATE UNIQUE INDEX "pedido_ticket_numero_key" ON "pedido"("ticket_numero");
ALTER TABLE "pedido" ADD CONSTRAINT "pedido_ticket_numero_check" CHECK ("ticket_numero" IS NULL OR "ticket_numero" > 0);
