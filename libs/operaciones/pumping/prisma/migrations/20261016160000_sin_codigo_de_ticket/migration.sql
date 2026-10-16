-- El ticket de Pumping no lleva numeración propia: el "ticket" es la prefactura (PRC-, de AS2). Se identifica por el pedido.
DROP INDEX IF EXISTS "ticket_codigo_key";
ALTER TABLE "ticket" DROP COLUMN "codigo";
DROP TABLE "contador";
