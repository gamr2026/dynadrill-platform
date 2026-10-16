-- PgBouncer valida a cada usuario de aplicación consultando esta función (auth_query),
-- así no hay que mantener una lista de usuarios y contraseñas dentro del pooler.
CREATE SCHEMA pgbouncer AUTHORIZATION postgres;

CREATE FUNCTION pgbouncer.get_auth(p_usename text)
RETURNS TABLE (usename name, passwd text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT s.usename, s.passwd::text FROM pg_catalog.pg_shadow s WHERE s.usename = p_usename;
$$;

REVOKE ALL ON FUNCTION pgbouncer.get_auth(text) FROM PUBLIC;
GRANT USAGE ON SCHEMA pgbouncer TO pgbouncer;
GRANT EXECUTE ON FUNCTION pgbouncer.get_auth(text) TO pgbouncer;
