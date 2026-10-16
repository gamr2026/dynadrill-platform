-- La zona del pedido es la del campo y sale del catálogo `catalogos.zona`: se guarda su id (sin FK entre schemas) más
-- la copia del nombre que ya existía.
ALTER TABLE "pedido" ADD COLUMN "zona_id" UUID;
