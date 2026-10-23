-- QHSE (S1): correcciones de la revisión adversarial de las migraciones de Desechos, Derrames y Emergencias (24/10/2026).
--  C1  Tres CHECK que se evaluaban a NULL (y por eso pasaban) con una columna nulable: derrame_volumen_check, emergencia_nivel_check y
--      emergencia_conteo_check. Se vuelven explícitos.
--  C2  Una emergencia de nivel 2 o 3 se cerraba sin investigación bajando el nivel antes de cerrar: ahora manda el nivel más alto declarado.
--  I1  Un derrame cerrado ya no se modifica, y lo registrado de la contención, del volumen y del cierre no se reescribe.
--  I2  Tras notificar al hospital, el hospital y el medio de transporte ya no cambian; los hitos y quién los registró no se reescriben.
--  I3  El cronómetro de una emergencia cerrada solo admite la línea automática del propio cierre.
--  I7  Los catálogos con comportamiento (estados, ubicaciones, pasos) ya no se pueden reescribir desde la aplicación: solo se ajusta lo que el
--      servicio realmente edita.
--  I8  A un desecho no peligroso no se le agregan características CRETIB después de registrarlo.
--  M8  El derrame no pasa a contenido si no hay ningún paso de contención activo.

-- C1 ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE "derrame" DROP CONSTRAINT "derrame_volumen_check";
ALTER TABLE "derrame" ADD CONSTRAINT "derrame_volumen_check" CHECK (
  ("volumen_real_barriles" IS NULL AND "volumen_confirmado_por" IS NULL AND "volumen_confirmado_at" IS NULL)
  OR ("volumen_real_barriles" IS NOT NULL AND "volumen_real_barriles" >= 0 AND "volumen_confirmado_por" IS NOT NULL
      AND "volumen_confirmado_at" IS NOT NULL AND "estado" <> 'activo'));

ALTER TABLE "emergencia" DROP CONSTRAINT "emergencia_nivel_check";
ALTER TABLE "emergencia" ADD CONSTRAINT "emergencia_nivel_check" CHECK (
  ("nivel" IS NULL AND "nivel_declarado_por" IS NULL AND "nivel_declarado_at" IS NULL)
  OR ("nivel" IS NOT NULL AND "nivel" BETWEEN 1 AND 3 AND "nivel_declarado_por" IS NOT NULL AND "nivel_declarado_at" IS NOT NULL));

ALTER TABLE "emergencia" DROP CONSTRAINT "emergencia_conteo_check";
ALTER TABLE "emergencia" ADD CONSTRAINT "emergencia_conteo_check" CHECK (
  ("total_en_locacion" IS NULL AND "evacuados" IS NULL AND "conteo_por" IS NULL AND "conteo_at" IS NULL)
  OR ("total_en_locacion" IS NOT NULL AND "evacuados" IS NOT NULL AND "total_en_locacion" >= 0 AND "evacuados" >= 0
      AND "evacuados" <= "total_en_locacion" AND "conteo_por" IS NOT NULL AND "conteo_at" IS NOT NULL));

-- I1 + M8 ------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "derrame_validar"() RETURNS trigger LANGUAGE plpgsql SET search_path = qhse, pg_catalog AS $$
DECLARE
  v_faltan INTEGER;
  v_activos INTEGER;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."estado" <> 'activo' THEN
      RAISE EXCEPTION 'Un derrame nace activo' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."estado" = 'cerrado' THEN
    RAISE EXCEPTION 'Un derrame cerrado ya no se modifica' USING ERRCODE = 'check_violation';
  END IF;
  -- lo registrado de la contención y del volumen no se reescribe (el volumen real se corrige con una confirmación nueva, que conserva su historial)
  IF (OLD."contenido_at" IS NOT NULL AND (NEW."contenido_at" IS DISTINCT FROM OLD."contenido_at" OR NEW."contenido_por" IS DISTINCT FROM OLD."contenido_por"))
     OR (OLD."volumen_confirmado_por" IS NOT NULL AND NEW."volumen_real_barriles" IS NOT DISTINCT FROM OLD."volumen_real_barriles"
         AND (NEW."volumen_confirmado_por" IS DISTINCT FROM OLD."volumen_confirmado_por" OR NEW."volumen_confirmado_at" IS DISTINCT FROM OLD."volumen_confirmado_at")) THEN
    RAISE EXCEPTION 'Lo registrado de la contención y del volumen real no se reescribe' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."notificado_mae_at" IS NOT NULL AND (NEW."notificado_mae_at" IS DISTINCT FROM OLD."notificado_mae_at"
      OR NEW."notificado_mae_por" IS DISTINCT FROM OLD."notificado_mae_por" OR NEW."mae_referencia" IS DISTINCT FROM OLD."mae_referencia") THEN
    RAISE EXCEPTION 'La notificación al MAE ya está registrada y no se cambia' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."notificado_mae_at" IS NULL AND NEW."notificado_mae_at" IS NOT NULL AND NOT "derrame_requiere_mae"(NEW."id") THEN
    RAISE EXCEPTION 'Este derrame no requiere notificar al MAE' USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."estado" = OLD."estado" THEN RETURN NEW; END IF;
  IF OLD."estado" = 'activo' AND NEW."estado" = 'contenido' THEN
    SELECT count(*) INTO v_activos FROM "derrame_checklist_item" WHERE "activo";
    IF v_activos = 0 THEN
      RAISE EXCEPTION 'No hay pasos de contención activos: configure el checklist antes de marcar un derrame como contenido' USING ERRCODE = 'check_violation';
    END IF;
    SELECT count(*) INTO v_faltan FROM "derrame_checklist_item" i
     WHERE i."activo" AND NOT EXISTS (SELECT 1 FROM "derrame_checklist_confirmacion" c WHERE c."derrame_id" = NEW."id" AND c."item_id" = i."id");
    IF v_faltan > 0 THEN
      RAISE EXCEPTION 'Para marcar el derrame como contenido hay que confirmar todo el checklist de contención (faltan %)', v_faltan USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."estado" = 'contenido' AND NEW."estado" = 'cerrado' THEN
    IF "derrame_requiere_mae"(NEW."id") AND NEW."notificado_mae_at" IS NULL THEN
      RAISE EXCEPTION 'Para cerrar el derrame hay que registrar la notificación al MAE' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Cambio de estado no permitido: de % a %', OLD."estado", NEW."estado" USING ERRCODE = 'check_violation';
END
$$;

-- I2 ------------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "herido_inmutable_validar"() RETURNS trigger LANGUAGE plpgsql SET search_path = qhse, pg_catalog AS $$
BEGIN
  IF NEW."emergencia_id" IS DISTINCT FROM OLD."emergencia_id" THEN
    RAISE EXCEPTION 'Un herido no se pasa a otra emergencia' USING ERRCODE = 'check_violation';
  END IF;
  -- los hitos del MEDEVAC y quién los registró no se deshacen ni se reescriben
  IF (OLD."medevac_at" IS NOT NULL AND (NEW."medevac_at" IS DISTINCT FROM OLD."medevac_at" OR NEW."medevac_por" IS DISTINCT FROM OLD."medevac_por"))
     OR (OLD."hospital_notificado_at" IS NOT NULL AND (NEW."hospital_notificado_at" IS DISTINCT FROM OLD."hospital_notificado_at"
         OR NEW."hospital_notificado_por" IS DISTINCT FROM OLD."hospital_notificado_por"))
     OR (OLD."transferido_at" IS NOT NULL AND (NEW."transferido_at" IS DISTINCT FROM OLD."transferido_at" OR NEW."transferido_por" IS DISTINCT FROM OLD."transferido_por")) THEN
    RAISE EXCEPTION 'Un hito del MEDEVAC ya registrado no se cambia' USING ERRCODE = 'check_violation';
  END IF;
  -- tras notificar al hospital, el hospital y el medio de transporte ya no cambian (el ETA puede ajustarse hasta transferir)
  IF OLD."hospital_notificado_at" IS NOT NULL AND (NEW."hospital_id" IS DISTINCT FROM OLD."hospital_id" OR NEW."medio_transporte" IS DISTINCT FROM OLD."medio_transporte") THEN
    RAISE EXCEPTION 'El hospital ya fue notificado: el hospital y el medio de transporte no se cambian' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."transferido_at" IS NOT NULL AND NEW."eta_minutos" IS DISTINCT FROM OLD."eta_minutos" THEN
    RAISE EXCEPTION 'El herido ya fue transferido: su destino no se cambia' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- I3 -----------------------------------------------------------------------------------------------------------------------
CREATE FUNCTION "emergencia_linea_validar"() RETURNS trigger LANGUAGE plpgsql SET search_path = qhse, pg_catalog AS $$
DECLARE
  v_estado "estado_emergencia";
BEGIN
  SELECT "estado" INTO v_estado FROM "emergencia" WHERE "id" = NEW."emergencia_id";
  IF v_estado = 'cerrada' AND NOT NEW."automatica" THEN
    RAISE EXCEPTION 'Una emergencia cerrada ya no recibe líneas del cronómetro' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "emergencia_linea_validar_trg" BEFORE INSERT ON "emergencia_linea" FOR EACH ROW EXECUTE FUNCTION "emergencia_linea_validar"();

-- C2 -----------------------------------------------------------------------------------------------------------------------
-- Manda el nivel MÁS ALTO declarado (no el vigente): bajar el nivel antes de cerrar no evita la investigación.
CREATE OR REPLACE FUNCTION "emergencia_validar"() RETURNS trigger LANGUAGE plpgsql SET search_path = qhse, pg_catalog AS $$
DECLARE
  v_swa "estado_swa";
  v_investigacion BOOLEAN;
  v_nivel_max SMALLINT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."estado" <> 'activa' THEN
      RAISE EXCEPTION 'Una emergencia nace activa' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."swa_id" IS NOT NULL THEN
      SELECT "estado" INTO v_swa FROM "swa" WHERE "id" = NEW."swa_id";
      IF v_swa = 'cerrado' THEN
        RAISE EXCEPTION 'Una SWA cerrada ya no escala a emergencia' USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF NEW."derrame_id" IS NOT NULL AND NOT "derrame_escala_a_emergencia"(NEW."derrame_id") THEN
      RAISE EXCEPTION 'Este derrame no escala a emergencia: solo el mayor o el que está en un cuerpo de agua' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."swa_id" IS DISTINCT FROM OLD."swa_id" OR NEW."derrame_id" IS DISTINCT FROM OLD."derrame_id" THEN
    RAISE EXCEPTION 'El origen de la emergencia no se cambia' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."estado" = 'cerrada' THEN
    RAISE EXCEPTION 'Una emergencia cerrada ya no se modifica' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."estado" = OLD."estado" THEN RETURN NEW; END IF;
  IF OLD."estado" = 'activa' AND NEW."estado" = 'controlada' THEN
    RETURN NEW;
  END IF;
  IF OLD."estado" = 'controlada' AND NEW."estado" = 'cerrada' THEN
    IF NOT EXISTS (SELECT 1 FROM "emergencia_reporte_flash" WHERE "emergencia_id" = NEW."id") THEN
      RAISE EXCEPTION 'Para cerrar la emergencia hay que emitir el Reporte Flash' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."nivel" IS NULL THEN
      RAISE EXCEPTION 'Para cerrar la emergencia hay que declarar su nivel' USING ERRCODE = 'check_violation';
    END IF;
    SELECT GREATEST(NEW."nivel", COALESCE(max("nivel"), 0)) INTO v_nivel_max FROM "emergencia_nivel_historial" WHERE "emergencia_id" = NEW."id";
    -- HSE-TRIAGE-002: el nivel 2 o 3 siempre origina una investigación. La tabla es de otra sesión: solo se comprueba si existe.
    IF v_nivel_max >= 2 AND to_regclass('qhse.investigacion') IS NOT NULL THEN
      EXECUTE 'SELECT EXISTS (SELECT 1 FROM qhse.investigacion WHERE origen_emergencia_id = $1)' INTO v_investigacion USING NEW."id";
      IF NOT v_investigacion THEN
        RAISE EXCEPTION 'Una emergencia que llegó al nivel 2 o 3 no se cierra sin su investigación de incidentes (HSE-TRIAGE-002)' USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Cambio de estado no permitido: de % a %', OLD."estado", NEW."estado" USING ERRCODE = 'check_violation';
END
$$;

-- I8 -----------------------------------------------------------------------------------------------------------------------
CREATE FUNCTION "desecho_caracteristica_validar"() RETURNS trigger LANGUAGE plpgsql SET search_path = qhse, pg_catalog AS $$
DECLARE
  v_clasificacion "clasificacion_desecho";
BEGIN
  SELECT "clasificacion" INTO v_clasificacion FROM "desecho" WHERE "id" = NEW."desecho_id";
  IF v_clasificacion = 'no_peligroso' THEN
    RAISE EXCEPTION 'Un desecho no peligroso no lleva características CRETIB' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "desecho_caracteristica_clasificacion_trg" BEFORE INSERT ON "desecho_caracteristica_asignada" FOR EACH ROW EXECUTE FUNCTION "desecho_caracteristica_validar"();

-- I7 -----------------------------------------------------------------------------------------------------------------------
-- Lo que decide el comportamiento (códigos y banderas) se cambia con una migración, no desde la aplicación. Del catálogo de bandas de volumen
-- se edita todo menos el código (lo hace el Gerente HSE); de los demás solo el nombre, el orden y si está activo.
REVOKE UPDATE ON "desecho_estado", "desecho_contenedor", "desecho_caracteristica", "derrame_ubicacion", "derrame_checklist_item", "emergencia_tipo",
                 "emergencia_paso_notificacion", "emergencia_hospital", "derrame_banda_volumen" FROM app_qhse;
GRANT UPDATE ("nombre", "orden", "activo", "updated_at", "updated_by") ON "desecho_estado" TO app_qhse;
GRANT UPDATE ("nombre", "orden", "activo", "updated_at", "updated_by") ON "desecho_contenedor" TO app_qhse;
GRANT UPDATE ("nombre", "orden", "activo", "updated_at", "updated_by") ON "desecho_caracteristica" TO app_qhse;
GRANT UPDATE ("nombre", "orden", "activo", "updated_at", "updated_by") ON "derrame_checklist_item" TO app_qhse;
GRANT UPDATE ("nombre", "orden", "activo", "updated_at", "updated_by") ON "emergencia_tipo" TO app_qhse;
GRANT UPDATE ("activo", "orden", "plazo_minutos", "updated_at", "updated_by") ON "emergencia_paso_notificacion" TO app_qhse;
GRANT UPDATE ("nombre", "ciudad", "telefono", "activo", "updated_at", "updated_by") ON "emergencia_hospital" TO app_qhse;
GRANT UPDATE ("nombre", "desde_barriles", "hasta_barriles", "exige_notificacion_mae", "escala_a_emergencia", "por_confirmar", "activo", "updated_at", "updated_by")
  ON "derrame_banda_volumen" TO app_qhse;
