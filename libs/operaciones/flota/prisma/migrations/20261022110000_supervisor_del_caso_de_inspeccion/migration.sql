-- D13 (21/10/2026): la inspección del vehículo la aprueba el supervisor asignado al ticket. El caso guarda quién es (lo trae el evento de asignación).
ALTER TABLE "inspeccion_caso" ADD COLUMN "supervisor_id" UUID;
ALTER TABLE "inspeccion_caso" ADD CONSTRAINT "inspeccion_caso_supervisor_id_fkey" FOREIGN KEY ("supervisor_id") REFERENCES identidad.usuario ("id");
CREATE INDEX "inspeccion_caso_supervisor_id_idx" ON "inspeccion_caso"("supervisor_id");
COMMENT ON COLUMN "inspeccion_caso"."supervisor_id" IS 'Supervisor asignado al ticket: el único que aprueba o rechaza las inspecciones del caso (nulo en casos anteriores a la regla).';
