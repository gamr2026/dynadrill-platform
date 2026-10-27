-- Estándar de la base de datos: toda tabla lleva su comentario en español (mantenimiento, 2 tablas).
COMMENT ON TABLE mantenimiento.contador IS 'Contador de secuencias de Mantenimiento (numeración de reportes y órdenes).';
COMMENT ON TABLE mantenimiento.transicion_suborden IS 'Pasos válidos entre dos estados de una sub-orden de mantenimiento.';
