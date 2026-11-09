-- Cada día del servicio recorre el ciclo (ejecución, retorno, llegada, revisión de llegada y revisión final). Al volver de la revisión final a la
-- ejecución para el siguiente día se recuerda hasta qué día llegó el ciclo, para que el ticket no vuelva a salir de la ejecución sin trabajar uno nuevo.
ALTER TABLE "pumping"."ticket" ADD COLUMN "ciclo_hasta" DATE;
COMMENT ON COLUMN "pumping"."ticket"."ciclo_hasta" IS 'Último día del servicio cuyo ciclo (hasta la revisión final) ya se completó; nulo mientras no se completó ninguno.';
