-- Corrección de herido_signos_vitales_presion_check (migración 20261024116530): con la presión diastólica en NULL, `NULL BETWEEN 0 AND 300` da NULL y
-- un CHECK que da NULL se acepta, así que se podía registrar solo la sistólica. Se vuelve explícito: la presión se toma completa (las dos
-- cifras) o no se toma, y la sistólica no es menor que la diastólica.
ALTER TABLE "herido_signos_vitales" DROP CONSTRAINT "herido_signos_vitales_presion_check";
ALTER TABLE "herido_signos_vitales" ADD CONSTRAINT "herido_signos_vitales_presion_check" CHECK (
  ("presion_sistolica" IS NULL AND "presion_diastolica" IS NULL)
  OR ("presion_sistolica" IS NOT NULL AND "presion_diastolica" IS NOT NULL
      AND "presion_sistolica" BETWEEN 0 AND 300 AND "presion_diastolica" BETWEEN 0 AND 300
      AND "presion_sistolica" >= "presion_diastolica"));
