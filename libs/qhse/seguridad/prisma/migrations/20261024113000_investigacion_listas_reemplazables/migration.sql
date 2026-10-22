-- Equipo, testigos y entorno se reemplazan completos al guardar (borrar y volver a crear dentro de una transacción), así que la aplicación necesita
-- DELETE solo en esas tres listas. El trigger `investigacion_hijo_editable` impide borrar cuando la investigación ya no admite cambios. El trabajador
-- y la información del incidente se actualizan en su lugar y no se borran.
GRANT DELETE ON "investigacion_equipo", "investigacion_testigo", "investigacion_entorno_factor" TO app_qhse;
