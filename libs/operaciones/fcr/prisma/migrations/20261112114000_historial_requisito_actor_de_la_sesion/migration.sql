-- El historial de requisitos también guarda quién hizo un cambio que la fila no registra (p. ej. quien revierte una exoneración): la aplicación
-- lo declara para la transacción con set_config('fcr.actor_id', <uuid>, true) y el trigger lo toma si la fila no trae un actor propio.
CREATE OR REPLACE FUNCTION fcr.registrar_historial_requisito() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_origen TEXT;
  v_actor UUID;
  v_sesion TEXT := NULLIF(current_setting('fcr.actor_id', true), '');
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.estado = OLD.estado THEN
    v_origen := 'revision'; v_actor := NULL; -- cambió solo vencido_at
  ELSIF NEW.estado = 'exonerado' THEN
    v_origen := 'manual'; v_actor := NEW.exonerado_por;
  ELSIF TG_OP = 'UPDATE' AND OLD.estado = 'exonerado' THEN
    v_origen := 'manual'; v_actor := NULL; -- la reversión de la exoneración
  ELSIF NEW.estado = 'cumplido' THEN
    v_origen := CASE WHEN NEW.origen = 'evento' THEN 'evento' ELSE 'sistema' END; v_actor := NEW.cumplido_por;
  ELSE
    v_origen := 'sistema'; v_actor := NULL;
  END IF;
  -- ids con gen_random_uuid() (UUIDv4): un trigger no puede pedirle a la aplicación un UUIDv7; el orden de lectura es por created_at
  INSERT INTO fcr.ticket_requisito_historial (id, ticket_requisito_id, ticket_id, estado_anterior, estado_nuevo, vencido, origen, actor_id, motivo)
  VALUES (gen_random_uuid(), NEW.id, NEW.ticket_id, CASE WHEN TG_OP = 'UPDATE' THEN OLD.estado END, NEW.estado, NEW.vencido_at IS NOT NULL, v_origen,
          COALESCE(v_actor, v_sesion::uuid), NEW.motivo);
  RETURN NULL;
END $$;
