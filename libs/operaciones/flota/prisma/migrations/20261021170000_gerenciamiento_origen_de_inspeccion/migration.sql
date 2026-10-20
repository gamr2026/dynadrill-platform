-- El origen y el destino del viaje ya se definieron en la inspección de salida de la unidad (punto de partida y destino): el
-- gerenciamiento de un ticket los toma de ahí (FK a la inspección, sin copiar el texto). Sin ticket siguen siendo una base o un pozo.
ALTER TABLE "flota"."gerenciamiento_viaje" ADD COLUMN "inspeccion_id" UUID;
ALTER TABLE "flota"."gerenciamiento_viaje"
  ADD CONSTRAINT "gerenciamiento_viaje_inspeccion_fkey" FOREIGN KEY ("inspeccion_id") REFERENCES "flota"."inspeccion_vehiculo"("id");
CREATE INDEX "gerenciamiento_viaje_inspeccion_id_idx" ON "flota"."gerenciamiento_viaje"("inspeccion_id");

ALTER TABLE "flota"."gerenciamiento_viaje" DROP CONSTRAINT "gerenciamiento_viaje_origen_check";
ALTER TABLE "flota"."gerenciamiento_viaje" DROP CONSTRAINT "gerenciamiento_viaje_destino_check";
ALTER TABLE "flota"."gerenciamiento_viaje"
  ADD CONSTRAINT "gerenciamiento_viaje_origen_check"
  CHECK (num_nonnulls("origen_bodega_id", "origen_pozo_id") = 1
         OR ("inspeccion_id" IS NOT NULL AND num_nonnulls("origen_bodega_id", "origen_pozo_id") = 0));
ALTER TABLE "flota"."gerenciamiento_viaje"
  ADD CONSTRAINT "gerenciamiento_viaje_destino_check"
  CHECK (num_nonnulls("destino_bodega_id", "destino_pozo_id") = 1
         OR ("inspeccion_id" IS NOT NULL AND num_nonnulls("destino_bodega_id", "destino_pozo_id") = 0));
COMMENT ON COLUMN "flota"."gerenciamiento_viaje"."inspeccion_id" IS 'Inspección de salida de la unidad en el ticket: de ahí salen el origen y el destino del viaje.';
