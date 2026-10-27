-- Estándar de la base de datos: toda tabla lleva su comentario en español (fcr, 5 tablas).
COMMENT ON TABLE fcr.bitacora_actividad IS 'Actividad de la bitácora diaria de un ticket de FCR: hora de inicio y fin y detalle de lo hecho.';
COMMENT ON TABLE fcr.paso_rol IS 'Roles de cuenta (identidad.rol.codigo) que pueden actuar en cada paso.';
COMMENT ON TABLE fcr.requisito IS 'Condiciones que el proceso exige (catálogo): de qué ámbito son, qué módulo es dueño del dato que las cumple y, si aplica a un solo tipo de OT, cuál.';
COMMENT ON TABLE fcr.ticket_tipo_servicio IS 'Tipos de servicio del pedido (código del catálogo de comercial: otro contenedor, sin FK).';
COMMENT ON TABLE fcr.transicion IS 'Pasos válidos entre dos pasos.';
