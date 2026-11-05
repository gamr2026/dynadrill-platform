-- Jornadas (etapa 7a): un servicio de varios días tiene un gerenciamiento de viaje de salida y uno de retorno por unidad y por día.
-- Antes era uno vigente por ticket, tipo y unidad; ahora es uno por ticket, tipo, unidad y día (la fecha del viaje).
DROP INDEX "flota"."gerenciamiento_viaje_ticket_tipo_unidad_vigente_key";
CREATE UNIQUE INDEX "gerenciamiento_viaje_ticket_tipo_unidad_fecha_vigente_key"
  ON "flota"."gerenciamiento_viaje" ("ticket_id", "tipo", "unidad_id", "fecha")
  WHERE "ticket_id" IS NOT NULL AND "decision" IS DISTINCT FROM 'rechazado';
