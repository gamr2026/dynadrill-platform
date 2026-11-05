-- Jornadas (etapa 7b): los equipos regresan a base cada día, así que el Reporte de Unidad (salida y llegada) se firma cada día del servicio.
-- El reporte pasa de uno por ticket y unidad a uno por ticket, unidad y día. Los reportes que ya existen quedan en el día de su salida.
ALTER TABLE "pumping"."reporte_unidad" ADD COLUMN "fecha" DATE;
UPDATE "pumping"."reporte_unidad"
   SET "fecha" = COALESCE("salida_fecha", ("created_at" AT TIME ZONE 'America/Guayaquil')::date);
ALTER TABLE "pumping"."reporte_unidad" ALTER COLUMN "fecha" SET NOT NULL;
-- sin día indicado, el de hoy en Ecuador
ALTER TABLE "pumping"."reporte_unidad" ALTER COLUMN "fecha" SET DEFAULT ((now() AT TIME ZONE 'America/Guayaquil')::date);

DROP INDEX "pumping"."reporte_unidad_ticket_unidad_key";
CREATE UNIQUE INDEX "reporte_unidad_ticket_unidad_fecha_key"
  ON "pumping"."reporte_unidad" ("ticket_id", "unidad_id", "fecha");
COMMENT ON COLUMN "pumping"."reporte_unidad"."fecha" IS 'Día del servicio al que pertenece el reporte (salida y llegada de ese día).';
