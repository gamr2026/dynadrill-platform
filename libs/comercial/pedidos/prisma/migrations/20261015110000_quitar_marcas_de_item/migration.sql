-- Las marcas químico / herramienta / movilización del ítem se retiran: Ventas no las elige y la de movilización se
-- deducía de un texto de la descripción (mala práctica). Si hacen falta se modelarán bien más adelante (categoría del ítem
-- de la lista de precios).
ALTER TABLE "pedido_item" DROP COLUMN "es_quimico", DROP COLUMN "es_herramienta", DROP COLUMN "es_movilizacion";
