-- CM-3 (PARIDAD-MODELO-DEMO.md): las horas de las actividades del Reporte Job y de la guía de remisión pasan de texto «HH:mm» a `time`
-- (como en Pumping). El CHECK de formato ya no hace falta: el tipo lo garantiza. No se exige fin >= inicio: una actividad puede cruzar la
-- medianoche (la duración se calcula así en Pumping).
ALTER TABLE "documento_operativo_actividad" DROP CONSTRAINT "documento_operativo_actividad_hora_check";
ALTER TABLE "documento_operativo_actividad"
  ALTER COLUMN "hora_inicio" TYPE TIME(0) USING "hora_inicio"::time,
  ALTER COLUMN "hora_fin" TYPE TIME(0) USING "hora_fin"::time;

ALTER TABLE "guia_remision" DROP CONSTRAINT "guia_remision_horas_check";
ALTER TABLE "guia_remision"
  ALTER COLUMN "hora_salida" TYPE TIME(0) USING "hora_salida"::time,
  ALTER COLUMN "hora_llegada" TYPE TIME(0) USING "hora_llegada"::time;
