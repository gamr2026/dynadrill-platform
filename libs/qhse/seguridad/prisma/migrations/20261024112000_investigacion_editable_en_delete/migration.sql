-- Corrección de 20261024111000: en un trigger de DELETE el registro NEW no está asignado, así que leer NEW."investigacion_id" fallaba al reemplazar las
-- listas (equipo, testigos, entorno). La prueba de integración lo encontró. Se lee de OLD en los borrados.
CREATE OR REPLACE FUNCTION "investigacion_hijo_editable"() RETURNS trigger LANGUAGE plpgsql SET search_path = qhse, pg_catalog AS $$
DECLARE v_estado "estado_investigacion";
BEGIN
  SELECT "estado" INTO v_estado FROM "investigacion"
   WHERE "id" = CASE WHEN TG_OP = 'DELETE' THEN OLD."investigacion_id" ELSE NEW."investigacion_id" END;
  IF v_estado NOT IN ('abierta', 'en_investigacion') THEN
    RAISE EXCEPTION 'La investigación ya no admite cambios' USING ERRCODE = 'check_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
