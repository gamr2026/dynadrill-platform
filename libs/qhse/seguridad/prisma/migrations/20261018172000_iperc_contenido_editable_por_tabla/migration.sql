-- Corrige iperc_contenido_editable: PL/pgSQL resolvía todos los campos de la fila en un solo CASE y fallaba en las tablas que no tienen
-- `matriz_id`. Ahora cada tabla tiene su rama y se consulta solo lo que le corresponde.
CREATE OR REPLACE FUNCTION "iperc_contenido_editable"() RETURNS trigger LANGUAGE plpgsql SET search_path = qhse, pg_catalog AS $$
DECLARE
  v_matriz UUID;
  v_estado "estado_iperc";
BEGIN
  IF TG_TABLE_NAME IN ('iperc_tarea', 'iperc_matriz_evaluador') THEN
    IF TG_OP = 'DELETE' THEN v_matriz := OLD."matriz_id"; ELSE v_matriz := NEW."matriz_id"; END IF;
  ELSIF TG_TABLE_NAME = 'iperc_tarea_cargo' THEN
    SELECT "matriz_id" INTO v_matriz FROM "iperc_tarea" WHERE "id" = (CASE WHEN TG_OP = 'DELETE' THEN OLD."tarea_id" ELSE NEW."tarea_id" END);
  ELSIF TG_TABLE_NAME = 'iperc_peligro' THEN
    SELECT "matriz_id" INTO v_matriz FROM "iperc_tarea" WHERE "id" = (CASE WHEN TG_OP = 'DELETE' THEN OLD."tarea_id" ELSE NEW."tarea_id" END);
  ELSIF TG_TABLE_NAME = 'iperc_control' THEN
    SELECT t."matriz_id" INTO v_matriz FROM "iperc_peligro" p JOIN "iperc_tarea" t ON t."id" = p."tarea_id"
     WHERE p."id" = (CASE WHEN TG_OP = 'DELETE' THEN OLD."peligro_id" ELSE NEW."peligro_id" END);
  END IF;
  SELECT "estado" INTO v_estado FROM "iperc_matriz" WHERE "id" = v_matriz;
  -- al borrar la matriz entera (solo pruebas, con dyn_migrator) la fila padre ya no existe
  IF v_estado IS NOT NULL AND v_estado NOT IN ('borrador', 'en_evaluacion') THEN
    RAISE EXCEPTION 'El contenido de la matriz no se puede cambiar (está %): una aprobada se revisa con una versión nueva', v_estado USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;
