-- La siembra retira del catálogo los permisos obsoletos (p. ej. los gruesos identidad.*.administrar al pasar
-- a permisos granulares) tras traspasar sus asignaciones. `permiso` es un catálogo, no un documento de negocio:
-- se concede DELETE solo sobre esta tabla. rol_permiso_historial sigue siendo de solo inserción.
GRANT DELETE ON "permiso" TO app_plataforma;
