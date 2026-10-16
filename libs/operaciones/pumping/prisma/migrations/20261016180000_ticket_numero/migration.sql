-- El ticket lleva el número de la prefactura que vendrá (reservado por comercial al abrir el pedido).
ALTER TABLE "ticket" ADD COLUMN "ticket_numero" INTEGER;
CREATE UNIQUE INDEX "ticket_ticket_numero_key" ON "ticket"("ticket_numero");
