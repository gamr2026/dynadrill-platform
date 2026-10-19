-- Corrige las restricciones de valoración de iperc_peligro: en SQL un CHECK cuyo resultado es desconocido (NULL) se acepta, así que con un
-- eje vacío y los otros dos llenos la restricción anterior no rechazaba nada. Ahora la valoración es completa (los tres ejes con sus valores
-- oficiales de la GTC 45) o está vacía (los tres NULL), de forma explícita.
ALTER TABLE "iperc_peligro" DROP CONSTRAINT "iperc_peligro_inicial_check";
ALTER TABLE "iperc_peligro" DROP CONSTRAINT "iperc_peligro_residual_check";
ALTER TABLE "iperc_peligro" ADD CONSTRAINT "iperc_peligro_inicial_check" CHECK (
  ("inicial_nd" IS NULL AND "inicial_ne" IS NULL AND "inicial_nc" IS NULL)
  OR ("inicial_nd" IS NOT NULL AND "inicial_ne" IS NOT NULL AND "inicial_nc" IS NOT NULL
      AND "inicial_nd" IN (0, 2, 6, 10) AND "inicial_ne" IN (1, 2, 3, 4) AND "inicial_nc" IN (10, 25, 60, 100)));
ALTER TABLE "iperc_peligro" ADD CONSTRAINT "iperc_peligro_residual_check" CHECK (
  ("residual_nd" IS NULL AND "residual_ne" IS NULL AND "residual_nc" IS NULL)
  OR ("residual_nd" IS NOT NULL AND "residual_ne" IS NOT NULL AND "residual_nc" IS NOT NULL
      AND "residual_nd" IN (0, 2, 6, 10) AND "residual_ne" IN (1, 2, 3, 4) AND "residual_nc" IN (10, 25, 60, 100)));
