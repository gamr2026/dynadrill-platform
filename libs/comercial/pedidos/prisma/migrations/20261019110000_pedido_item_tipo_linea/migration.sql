-- C1 de plan-comercial-ajustes: tipo de línea del pedido (la demo main lo distingue: servicio, material, herramienta, movilización).
CREATE TYPE "tipo_linea" AS ENUM ('servicio', 'material', 'herramienta', 'movilizacion');

ALTER TABLE "pedido_item" ADD COLUMN "tipo_linea" "tipo_linea" NOT NULL DEFAULT 'servicio';

-- Las líneas ya guardadas: el tipo de su ítem de la lista de precios; la movilización se reconoce por la descripción.
UPDATE "pedido_item" pi
   SET "tipo_linea" = CASE
         WHEN pi."descripcion" ILIKE '%moviliz%' THEN 'movilizacion'::"tipo_linea"
         WHEN li."tipo" = 'Material' THEN 'material'::"tipo_linea"
         ELSE 'servicio'::"tipo_linea"
       END
  FROM "lista_precios_item" li
 WHERE li."id" = pi."lista_precios_item_id";
UPDATE "pedido_item" SET "tipo_linea" = 'movilizacion' WHERE "lista_precios_item_id" IS NULL AND "descripcion" ILIKE '%moviliz%';
