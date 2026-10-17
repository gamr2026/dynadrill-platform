-- Los rechazos (volver a un paso anterior) no exigen que el paso de origen esté completo: se modela en la transición.
ALTER TABLE "transicion" ADD COLUMN "exige_requisitos" BOOLEAN NOT NULL DEFAULT true;
UPDATE "transicion" SET "exige_requisitos" = false WHERE "origen_codigo" = 'revision_final' AND "destino_codigo" = 'revision_reportes_llegada';
