-- Cada conductor solicita el gerenciamiento de viaje de SU unidad: los requisitos de salida y de retorno pasan de ser del ticket a ser
-- de cada unidad. Los tickets que ya existen cambian su fila única por una por unidad (pendiente: el gerenciamiento se vuelve a pedir).
UPDATE "pumping"."requisito"
SET "ambito" = 'unidad'
WHERE "codigo" IN ('gerenciamiento_viaje_salida_aprobado', 'gerenciamiento_viaje_retorno_aprobado');

DELETE FROM "pumping"."ticket_requisito"
WHERE "requisito_codigo" IN ('gerenciamiento_viaje_salida_aprobado', 'gerenciamiento_viaje_retorno_aprobado')
  AND "vehiculo_id" IS NULL;

INSERT INTO "pumping"."ticket_requisito" ("id", "ticket_id", "requisito_codigo", "vehiculo_id")
SELECT gen_random_uuid(), tu."ticket_id", r."codigo", tu."vehiculo_id"
FROM "pumping"."ticket_unidad" tu
CROSS JOIN (VALUES ('gerenciamiento_viaje_salida_aprobado'), ('gerenciamiento_viaje_retorno_aprobado')) AS r("codigo")
WHERE EXISTS (SELECT 1 FROM "pumping"."ticket_requisito" x WHERE x."ticket_id" = tu."ticket_id")
ON CONFLICT DO NOTHING;
