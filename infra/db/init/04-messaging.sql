-- Outbox e inbox de cada contenedor (Propuesta de BD v1, cap. 5.14 y SQL `msg_*`).
-- Se crean como dyn_migrator para que sean suyas y apliquen los privilegios por defecto de 02-schemas.sql.
-- Son idénticas en los cinco schemas `msg_*`; este archivo es idempotente (re-ejecutable).

SET ROLE dyn_migrator;

DO $$
DECLARE
  s text;
BEGIN
  FOREACH s IN ARRAY ARRAY['msg_plataforma', 'msg_comercial', 'msg_operaciones', 'msg_qhse', 'msg_worker'] LOOP
    EXECUTE format($f$
      CREATE TABLE IF NOT EXISTS %1$I.outbox (
        id             uuid PRIMARY KEY,
        tipo           text        NOT NULL,
        version_evento smallint    NOT NULL,
        datos          jsonb       NOT NULL,
        ocurrido_at    timestamptz NOT NULL DEFAULT now(),
        publicado_at   timestamptz,
        intentos       integer     NOT NULL DEFAULT 0,
        ultimo_error   text
      )$f$, s);
    EXECUTE format('COMMENT ON TABLE %I.outbox IS %L', s,
      'Eventos por publicar; se guardan en la misma transacción que el cambio de estado');
    -- el relay solo lee los pendientes: índice parcial pequeño aunque la tabla crezca
    EXECUTE format('CREATE INDEX IF NOT EXISTS outbox_pendientes_idx ON %I.outbox (ocurrido_at, id) WHERE publicado_at IS NULL', s);
    EXECUTE format('CREATE INDEX IF NOT EXISTS outbox_publicados_idx ON %I.outbox (publicado_at) WHERE publicado_at IS NOT NULL', s);

    EXECUTE format($f$
      CREATE TABLE IF NOT EXISTS %1$I.inbox (
        id           uuid PRIMARY KEY,
        tipo         text        NOT NULL,
        procesado_at timestamptz NOT NULL DEFAULT now()
      )$f$, s);
    EXECUTE format('COMMENT ON TABLE %I.inbox IS %L', s,
      'Eventos ya procesados por este contenedor (idempotencia del consumidor)');
  END LOOP;
END
$$;

RESET ROLE;
