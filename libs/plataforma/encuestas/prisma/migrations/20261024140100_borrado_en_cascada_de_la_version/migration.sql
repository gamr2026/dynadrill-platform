-- El disparador de preguntas y opciones solo debe bloquear el cambio directo de una versión publicada. Si la versión ya no existe es porque se
-- está borrando entera (borrado en cascada, que solo hace el dueño del schema: la aplicación no tiene DELETE sobre la versión), y eso no se bloquea.
CREATE OR REPLACE FUNCTION "encuestas"."exigir_version_en_borrador"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v UUID;
  est "encuestas"."estado_version";
BEGIN
  IF TG_TABLE_NAME = 'pregunta' THEN
    v := COALESCE(NEW."version_id", OLD."version_id");
  ELSE
    SELECT p."version_id" INTO v FROM "encuestas"."pregunta" p WHERE p."id" = COALESCE(NEW."pregunta_id", OLD."pregunta_id");
    -- la pregunta ya no existe: se está borrando en cascada y su propio borrado ya se comprobó
    IF v IS NULL THEN RETURN COALESCE(NEW, OLD); END IF;
  END IF;
  SELECT "estado" INTO est FROM "encuestas"."encuesta_version" WHERE "id" = v;
  -- la versión ya no existe: se está borrando entera
  IF est IS NULL AND TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF est IS DISTINCT FROM 'borrador' THEN
    RAISE EXCEPTION 'Una versión publicada de la encuesta no se modifica: cree una versión nueva' USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END
$$;
