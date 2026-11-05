-- Jornadas (etapa 7a): los equipos regresan a base cada día, así que la inspección de vehículos se repite en cada día del servicio.
-- La inspección gana el día del servicio al que pertenece (por omisión, el día de ecuador de su fecha) y la unicidad «una vigente por caso y
-- momento» pasa a ser «una vigente por caso, momento y día». Pumping toma de ahí el requisito de cada jornada.
ALTER TABLE "flota"."inspeccion_vehiculo" ADD COLUMN "dia_servicio" DATE;
UPDATE "flota"."inspeccion_vehiculo" SET "dia_servicio" = ("fecha" AT TIME ZONE 'America/Guayaquil')::date;
ALTER TABLE "flota"."inspeccion_vehiculo" ALTER COLUMN "dia_servicio" SET NOT NULL;

DROP INDEX "flota"."inspeccion_vehiculo_caso_momento_vigente_key";
CREATE UNIQUE INDEX "inspeccion_vehiculo_caso_momento_dia_vigente_key"
  ON "flota"."inspeccion_vehiculo" ("caso_id", "momento", "dia_servicio") WHERE "caso_id" IS NOT NULL AND "anulada_at" IS NULL;
COMMENT ON COLUMN "flota"."inspeccion_vehiculo"."dia_servicio" IS 'Día del servicio al que pertenece la inspección (un servicio de varios días tiene una inspección de salida y una de llegada por día).';
