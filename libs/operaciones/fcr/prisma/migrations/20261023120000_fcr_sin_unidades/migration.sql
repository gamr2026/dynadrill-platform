-- FCR no lleva unidades (vehículos) ni reporte de unidad de llegada: no existen en el flujo de la demo (la asignación de FCR elige solo al operador) ni
-- en las especificaciones ni en los pasos del proceso. Se retira lo que se había agregado de más (decisión del 21/10/2026): el requisito del control de
-- retorno, el reporte de llegada y las unidades del ticket.

-- 1) El requisito `reporte_unidad_llegada` deja de existir (en los tickets, en los pasos y en el catálogo).
DELETE FROM "ticket_requisito" WHERE "requisito_codigo" = 'reporte_unidad_llegada';
DELETE FROM "paso_requisito" WHERE "requisito_codigo" = 'reporte_unidad_llegada';
DELETE FROM "requisito" WHERE "codigo" = 'reporte_unidad_llegada';

-- 2) El reporte de unidad de llegada (estaba vacío en la práctica).
DROP TABLE "reporte_unidad_llegada";

-- 3) Los requisitos ya no se pueden referir a una unidad.
ALTER TABLE "ticket_requisito" DROP CONSTRAINT "ticket_requisito_unidad_fkey";
ALTER TABLE "ticket_requisito" DROP CONSTRAINT "ticket_requisito_vehiculo_fkey";
ALTER TABLE "ticket_requisito" DROP CONSTRAINT "ticket_requisito_ambito_check";
DROP INDEX "ticket_requisito_unico_key";
ALTER TABLE "ticket_requisito" DROP COLUMN "vehiculo_id";
CREATE UNIQUE INDEX "ticket_requisito_unico_key" ON "ticket_requisito" ("ticket_id", "requisito_codigo", "usuario_id") NULLS NOT DISTINCT;

-- 4) Los operadores no llevan unidad y el ticket no tiene unidades asignadas.
ALTER TABLE "ticket_persona" DROP CONSTRAINT "ticket_persona_unidad_fkey";
ALTER TABLE "ticket_persona" DROP CONSTRAINT "ticket_persona_unidad_check";
DROP INDEX "ticket_persona_vehiculo_idx";
ALTER TABLE "ticket_persona" DROP COLUMN "vehiculo_id";
DROP TABLE "ticket_unidad";

COMMENT ON TABLE "ticket_persona" IS 'Equipo del ticket: un supervisor y los operadores. Solo ellos actúan en los pasos que requieren equipo.';
COMMENT ON TABLE "ticket_requisito" IS 'Estado de cada requisito de un ticket (del ticket o de uno de sus operadores). Se cumple desde FCR, por un evento de otro módulo o con el puente temporal.';
