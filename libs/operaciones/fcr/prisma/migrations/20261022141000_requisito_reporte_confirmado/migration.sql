-- La confirmación previa a finalizar la ejecución pasa a ser la del Reporte de Herramientas por ítem (antes, la del listado de uso por herramienta).
UPDATE "requisito"
SET "nombre" = 'Reporte de herramientas confirmado',
    "descripcion" = 'El operador confirmó que el Reporte de Herramientas (códigos de la lista de precios con su cantidad real) está completo.'
WHERE "codigo" = 'listado_uso_confirmado';
