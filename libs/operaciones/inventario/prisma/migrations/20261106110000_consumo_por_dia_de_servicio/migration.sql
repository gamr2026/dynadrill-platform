-- Jornadas (etapa 8): el consumo de químicos pasa a registrarse por día del servicio. Hasta ahora solo guardaba cuándo se anotó (`fecha`),
-- y con un servicio de varios días no se podía reconstruir cuánto se usó cada día. Los consumos que ya existen quedan en el día de Ecuador en que
-- se anotaron.
ALTER TABLE "inventario"."consumo_ticket" ADD COLUMN "dia_servicio" DATE;
UPDATE "inventario"."consumo_ticket" SET "dia_servicio" = ("fecha" AT TIME ZONE 'America/Guayaquil')::date;
ALTER TABLE "inventario"."consumo_ticket" ALTER COLUMN "dia_servicio" SET NOT NULL;
-- sin día indicado, el de hoy en Ecuador
ALTER TABLE "inventario"."consumo_ticket" ALTER COLUMN "dia_servicio" SET DEFAULT ((now() AT TIME ZONE 'America/Guayaquil')::date);
CREATE INDEX "consumo_ticket_ticket_pumping_id_dia_servicio_idx" ON "inventario"."consumo_ticket" ("ticket_pumping_id", "dia_servicio");
COMMENT ON COLUMN "inventario"."consumo_ticket"."dia_servicio" IS 'Día del servicio en que se usó lo consumido (`fecha` es cuándo se anotó).';
