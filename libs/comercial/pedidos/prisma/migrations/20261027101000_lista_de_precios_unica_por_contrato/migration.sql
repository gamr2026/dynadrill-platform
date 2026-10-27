-- Una lista de precios por cliente y contrato (sin importar mayúsculas ni espacios): al crear una lista desde el portal no se duplica el contrato.
CREATE UNIQUE INDEX "lista_precios_cliente_contrato_key"
  ON "lista_precios" ("cliente_id", lower(btrim("numero_contrato")))
  WHERE "cliente_id" IS NOT NULL AND "numero_contrato" IS NOT NULL;
