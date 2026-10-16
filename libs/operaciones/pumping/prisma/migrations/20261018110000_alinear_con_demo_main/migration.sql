-- Alineación con el main de la demo (08/10/2026): el checklist de ingreso a locación (gases y LOTO) se exige para salir de la EJECUCIÓN, no del traslado de salida.
UPDATE "paso_requisito" SET "paso_codigo" = 'ejecucion_operativa' WHERE "requisito_codigo" = 'checklist_ingreso_locacion' AND "paso_codigo" = 'traslado_salida';
