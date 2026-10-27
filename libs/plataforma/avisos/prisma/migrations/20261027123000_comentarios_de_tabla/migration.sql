-- Estándar de la base de datos: toda tabla lleva su comentario en español (avisos, 3 tablas).
COMMENT ON TABLE avisos.aviso IS 'Aviso de la campanita: uno por persona y hecho.';
COMMENT ON TABLE avisos.plantilla IS 'Texto de un aviso. Los valores entre llaves dobles se reemplazan con los datos del evento: {{pedido}}, {{cliente}}... y con los de la persona que lo recibe: {{nombre}}, {{cargo}}.';
COMMENT ON TABLE avisos.regla_aviso IS 'Cuando ocurre evento_tipo, las personas activas con el rol rol_codigo reciben el aviso con esta plantilla.';
