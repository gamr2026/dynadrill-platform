-- El cierre del día (Ejecución operativa) ya no exige el reporte de unidad de llegada ni el gerenciamiento de viaje de retorno: cada día
-- recorre su ciclo, y esas dos cosas se hacen en sus pasos (Control de retorno: gerenciamiento de viaje de retorno; Traslado de llegada:
-- reporte de unidad de llegada). Los hechos de Flota y las firmas siguen guardados; esos pasos los leen de ahí.
DELETE FROM "pumping"."ticket_requisito"
 WHERE "requisito_codigo" IN ('reporte_unidad_llegada_dia', 'gerenciamiento_retorno_dia');
UPDATE "pumping"."requisito" SET "activo" = false
 WHERE "codigo" IN ('reporte_unidad_llegada_dia', 'gerenciamiento_retorno_dia');
