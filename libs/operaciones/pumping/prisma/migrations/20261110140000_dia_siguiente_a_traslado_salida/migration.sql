-- El día siguiente de un servicio de varios días empieza en el Traslado de salida (cada día es una salida y un regreso a la base), no en la
-- Ejecución operativa: de la Revisión final se vuelve al Traslado de salida.
DELETE FROM "pumping"."transicion"
 WHERE "origen_codigo" = 'revision_final' AND "destino_codigo" = 'ejecucion_operativa';
INSERT INTO "pumping"."transicion" ("id", "origen_codigo", "destino_codigo", "requiere_motivo", "exige_requisitos", "activa")
VALUES (gen_random_uuid(), 'revision_final', 'traslado_salida', false, false, true)
ON CONFLICT ("origen_codigo", "destino_codigo") DO NOTHING;
