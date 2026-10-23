-- La excepción del trigger de inmutabilidad deja de ser automática para dyn_migrator: ahora exige además un ajuste de sesión
-- explícito (`SET LOCAL auditoria.limpieza_de_pruebas = 'on'`), que solo usan las pruebas de integración para limpiar lo suyo.
-- Sin el ajuste, ni el dueño del DDL puede modificar ni borrar la historia por descuido.
CREATE OR REPLACE FUNCTION auditoria.rechazar_cambio_de_historia() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'dyn_migrator' AND current_setting('auditoria.limpieza_de_pruebas', true) = 'on' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  RAISE EXCEPTION 'La auditoría es inmutable: no se permite % en %.%', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;
