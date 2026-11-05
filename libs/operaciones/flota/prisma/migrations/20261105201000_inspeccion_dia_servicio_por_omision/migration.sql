-- El día del servicio de una inspección, si no se indica, es el día de Ecuador de su fecha (así toda inserción queda consistente).
CREATE FUNCTION "flota"."inspeccion_vehiculo_dia_por_omision"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."dia_servicio" IS NULL THEN
    NEW."dia_servicio" := (NEW."fecha" AT TIME ZONE 'America/Guayaquil')::date;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "inspeccion_vehiculo_dia_por_omision" BEFORE INSERT ON "flota"."inspeccion_vehiculo"
  FOR EACH ROW EXECUTE FUNCTION "flota"."inspeccion_vehiculo_dia_por_omision"();
