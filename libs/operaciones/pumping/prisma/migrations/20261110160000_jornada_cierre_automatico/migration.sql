-- Al cumplirse lo último que exige el cierre, el sistema cierra la jornada solo (como abre la jornada con el último requisito de apertura): queda
-- con la hora del cierre y sin persona. Quien cierra a mano sigue dejando su nombre.
ALTER TABLE "pumping"."ticket_jornada" DROP CONSTRAINT "ticket_jornada_cierre_check";
ALTER TABLE "pumping"."ticket_jornada"
  ADD CONSTRAINT "ticket_jornada_cierre_check" CHECK ("cerrada_por" IS NULL OR "cerrada_at" IS NOT NULL);
