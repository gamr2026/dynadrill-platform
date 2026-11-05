-- Jornadas (etapa 4): la salida de Ejecución operativa pasa a depender de las jornadas (todas cerradas, sin operación o que no aplican) y
-- se retiran dos condiciones de ticket que ya no tienen sentido: el checklist de ingreso único y la formalización única del Company Man.
-- Ahora cada día exige su checklist (`checklist_seguridad_dia`) y la aceptación del Company Man (`company_man_acepto_dia`).
-- Siguen exigiéndose para salir: el Reporte de Herramientas completo (se envía a Comercial) y, en el paso siguiente, lo que ya tenían.
-- Los requisitos no se borran (los tickets existentes los referencian): solo dejan de ser condición de ningún paso y se inactivan.

DELETE FROM "pumping"."paso_requisito"
 WHERE "paso_codigo" = 'ejecucion_operativa'
   AND "requisito_codigo" IN ('checklist_ingreso_locacion', 'ejecucion_formalizada');

UPDATE "pumping"."requisito"
   SET "activo" = false,
       "descripcion" = 'Retirado (5/11/2026): lo reemplazan el checklist de seguridad de cada día (checklist_seguridad_dia) y la aceptación diaria del Company Man (company_man_acepto_dia).'
 WHERE "codigo" IN ('checklist_ingreso_locacion', 'ejecucion_formalizada');
