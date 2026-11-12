-- Anulación del ticket cuando se anula el pedido (12/11/2026): paso terminal «anulado», al que se llega desde cualquier paso no terminal.
-- El valor 'anulado' del enum macro_estado se agregó en la migración anterior.
-- En una base nueva todavía no hay pasos (los siembra `sembrarPasos`, que ya trae «anulado» y sus transiciones): aquí solo se completa
-- el catálogo existente.
INSERT INTO "fcr"."paso" ("codigo", "nombre", "macro", "orden", "terminal", "requiere_equipo", "activo")
SELECT 'anulado', 'Anulado', 'anulado', 130, true, false, true
WHERE EXISTS (SELECT 1 FROM "fcr"."paso")
ON CONFLICT DO NOTHING;

INSERT INTO "fcr"."paso_rol" ("paso_codigo", "rol_codigo")
SELECT 'anulado', 'supervisor'
WHERE EXISTS (SELECT 1 FROM "fcr"."paso" WHERE "codigo" = 'anulado')
  AND EXISTS (SELECT 1 FROM identidad.rol WHERE "codigo" = 'supervisor')
ON CONFLICT DO NOTHING;

-- Solo la hace el sistema (por el evento del pedido anulado): no es un avance que la bandeja ofrezca, siempre lleva motivo y no exige requisitos.
INSERT INTO "fcr"."transicion" ("id", "origen_codigo", "destino_codigo", "requiere_motivo", "exige_requisitos", "activa", "solo_por_accion")
SELECT gen_random_uuid(), p."codigo", 'anulado', true, false, true, true
FROM "fcr"."paso" p
WHERE NOT p."terminal" AND EXISTS (SELECT 1 FROM "fcr"."paso" WHERE "codigo" = 'anulado')
ON CONFLICT ("origen_codigo", "destino_codigo") DO NOTHING;
