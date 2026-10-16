-- Se retiran dos roles que no corresponden al negocio:
--  * ingenieria_ventas_fcr: quedó en la base de la demo por una implementación errónea; no tiene participación real.
--  * coordinador_hse: no existe; solo hay Gerente HSE y Técnico HSE. Sus permisos pasan al Gerente HSE; los del Técnico
--    no cambian.
-- Las cuentas que los tenían (simulaciones inactivas) pasan al rol que los sustituye, y se borran los roles junto con sus
-- asignaciones y su bitácora de permisos (que solo tiene sentido mientras el rol existe).

-- 1) Los permisos del Coordinador pasan al Gerente (sin pisar los que ya tiene) y queda constancia en la bitácora.
INSERT INTO "rol_permiso_historial" ("id", "rol_id", "permiso_codigo", "accion", "realizado_por", "realizado_at")
SELECT gen_random_uuid(), g."id", p."codigo", 'otorgado', NULL, now()
FROM "rol_permiso" rp
JOIN "rol" c ON c."id" = rp."rol_id" AND c."codigo" = 'coordinador_hse'
JOIN "rol" g ON g."codigo" = 'gerente_hse'
JOIN "permiso" p ON p."id" = rp."permiso_id"
WHERE NOT EXISTS (SELECT 1 FROM "rol_permiso" x WHERE x."rol_id" = g."id" AND x."permiso_id" = rp."permiso_id");

INSERT INTO "rol_permiso" ("rol_id", "permiso_id", "asignado_at", "asignado_por")
SELECT g."id", rp."permiso_id", now(), NULL
FROM "rol_permiso" rp
JOIN "rol" c ON c."id" = rp."rol_id" AND c."codigo" = 'coordinador_hse'
JOIN "rol" g ON g."codigo" = 'gerente_hse'
ON CONFLICT DO NOTHING;

-- 2) Las cuentas (inactivas) pasan al rol sucesor.
UPDATE "usuario" SET "rol_id" = (SELECT "id" FROM "rol" WHERE "codigo" = 'gerente_hse')
WHERE "rol_id" = (SELECT "id" FROM "rol" WHERE "codigo" = 'coordinador_hse');
UPDATE "usuario" SET "rol_id" = (SELECT "id" FROM "rol" WHERE "codigo" = 'ingenieria_ventas')
WHERE "rol_id" = (SELECT "id" FROM "rol" WHERE "codigo" = 'ingenieria_ventas_fcr');

-- 3) Se borran los roles con sus asignaciones y su bitácora.
DELETE FROM "rol_permiso_historial" WHERE "rol_id" IN (SELECT "id" FROM "rol" WHERE "codigo" IN ('coordinador_hse', 'ingenieria_ventas_fcr'));
DELETE FROM "rol_permiso" WHERE "rol_id" IN (SELECT "id" FROM "rol" WHERE "codigo" IN ('coordinador_hse', 'ingenieria_ventas_fcr'));
DELETE FROM "rol" WHERE "codigo" IN ('coordinador_hse', 'ingenieria_ventas_fcr');
