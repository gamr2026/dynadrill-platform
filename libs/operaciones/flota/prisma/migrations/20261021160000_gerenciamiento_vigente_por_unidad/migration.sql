-- Un gerenciamiento de viaje vigente por ticket, tipo y unidad: cada conductor solicita el de su unidad (antes era uno por ticket).
DROP INDEX IF EXISTS "flota"."gerenciamiento_viaje_ticket_tipo_vigente_key";
CREATE UNIQUE INDEX "gerenciamiento_viaje_ticket_tipo_unidad_vigente_key"
  ON "flota"."gerenciamiento_viaje" ("ticket_id", "tipo", "unidad_id")
  WHERE "ticket_id" IS NOT NULL AND "decision" IS DISTINCT FROM 'rechazado';
