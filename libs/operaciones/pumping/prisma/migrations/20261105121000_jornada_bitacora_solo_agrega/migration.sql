-- La bitácora de la jornada solo se agrega: el rol de la aplicación recibe UPDATE y DELETE por privilegios por defecto, así que se le quitan
-- explícitamente (en la migración anterior bastaba con no concederlos, pero la prueba de integración mostró que sí los tenía).
REVOKE UPDATE, DELETE, TRUNCATE ON "pumping"."ticket_jornada_historial" FROM app_operaciones;
