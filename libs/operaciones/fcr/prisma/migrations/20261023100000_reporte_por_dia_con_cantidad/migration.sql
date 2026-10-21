-- El Reporte de Herramientas se reparte por día como los formatos reales: cada celda de la matriz ítem × día lleva su cantidad (1 en las filas de
-- tiempo; los km, pies, galones, horas o unidades fraccionadas del día en que se aplicaron). La cantidad total de la fila es la suma de sus celdas.
-- Además el reporte nace precargado con los ítems cotizados del pedido (menos la movilización, que no va en este reporte).

-- 1) Cantidad por día: se pasa a la celda del primer día del servicio la cantidad escrita antes en las filas que no eran por día.
ALTER TABLE "reporte_item_dia" ADD COLUMN "cantidad" NUMERIC(14,3) NOT NULL DEFAULT 1;
ALTER TABLE "reporte_item_dia" ADD CONSTRAINT "reporte_item_dia_cantidad_check" CHECK ("cantidad" > 0);
COMMENT ON COLUMN "reporte_item_dia"."cantidad" IS 'Cantidad aplicada ese día (1 en las filas por día; el valor real en las demás). El total de la fila es la suma.';

INSERT INTO "reporte_item_dia" ("id", "item_id", "fecha", "estado", "cantidad", "created_by")
SELECT gen_random_uuid(), i."id", COALESCE(t."fecha_inicio_servicio"::date, i."created_at"::date), 'operacion', i."cantidad", i."created_by"
  FROM "reporte_item" i
  JOIN "ticket" t ON t."id" = i."ticket_id"
 WHERE NOT i."por_dia" AND i."cantidad" IS NOT NULL;

ALTER TABLE "reporte_item" DROP CONSTRAINT "reporte_item_cantidad_check";
ALTER TABLE "reporte_item" DROP COLUMN "cantidad";
COMMENT ON COLUMN "reporte_item"."por_dia" IS 'La unidad es de tiempo (día): sus celdas son marcas O/D/V que valen 1; en las demás filas cada celda lleva su cantidad.';

-- 2) Los ítems que el pedido trajo de AS2 pueden no estar enlazados a la lista de precios: el enlace pasa a ser opcional.
ALTER TABLE "reporte_item" ALTER COLUMN "lista_precios_item_id" DROP NOT NULL;

-- 3) La precarga del reporte sale de las líneas cotizadas del ticket: guardan el ítem de la lista de precios (otro contenedor: uuid sin FK) y el ticket
--    anota cuándo se hizo la precarga para no volver a agregar lo que el operador quitó.
ALTER TABLE "ticket_linea" ADD COLUMN "lista_precios_item_id" UUID;
COMMENT ON COLUMN "ticket_linea"."lista_precios_item_id" IS 'Ítem de la lista de precios del cliente en `comercial` (otro contenedor, D1): uuid sin FK; vacío si el ítem vino de AS2 sin enlace.';
ALTER TABLE "ticket" ADD COLUMN "reporte_precargado_at" TIMESTAMPTZ(6);
COMMENT ON COLUMN "ticket"."reporte_precargado_at" IS 'Cuándo se precargó el Reporte de Herramientas con los ítems cotizados (una sola vez, al llegar a la Ejecución operativa).';
