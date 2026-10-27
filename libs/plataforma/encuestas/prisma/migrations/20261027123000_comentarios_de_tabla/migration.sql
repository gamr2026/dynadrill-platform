-- Estándar de la base de datos: toda tabla lleva su comentario en español (encuestas, 7 tablas).
COMMENT ON TABLE encuestas.encuesta IS 'Plantilla de encuesta. Lo que se envía es una de sus versiones.';
COMMENT ON TABLE encuestas.encuesta_version IS 'Una versión publicada no se edita: un cambio crea una versión nueva.';
COMMENT ON TABLE encuestas.escala IS 'Escala de calificación (por ejemplo 1 a 5 con sus etiquetas).';
COMMENT ON TABLE encuestas.escala_valor IS 'Valor de una escala de calificación: su número y su etiqueta (por ejemplo 5 = Excelente).';
COMMENT ON TABLE encuestas.pregunta IS 'Pregunta de una versión de encuesta, en el orden en que se presenta.';
COMMENT ON TABLE encuestas.pregunta_opcion IS 'Opción de respuesta de una pregunta de elección.';
COMMENT ON TABLE encuestas.respuesta_encuesta IS 'Lo que contestó el cliente con un enlace.';
