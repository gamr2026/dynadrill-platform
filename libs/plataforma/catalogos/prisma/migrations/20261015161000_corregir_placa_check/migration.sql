-- Corrige la restricción de la placa de `vehiculo`: la migración anterior quedó con "(5, 8)" en lugar de "{5,8}".
ALTER TABLE "vehiculo" DROP CONSTRAINT "vehiculo_placa_check";
ALTER TABLE "vehiculo" ADD CONSTRAINT "vehiculo_placa_check" CHECK ("placa" ~ '^[A-Z0-9]{5,8}$');
