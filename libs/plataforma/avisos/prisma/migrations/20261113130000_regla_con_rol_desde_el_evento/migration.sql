-- Una regla puede tomar el rol de quien recibe el aviso de un campo del evento (p. ej. `rolResponsable` de un requisito vencido), en lugar de un rol fijo.
ALTER TABLE "avisos"."regla_aviso" ADD COLUMN "rol_desde_campo" TEXT;
ALTER TABLE "avisos"."regla_aviso"
  ADD CONSTRAINT "regla_aviso_rol_desde_campo_check" CHECK ("rol_desde_campo" IS NULL OR "rol_desde_campo" ~ '^[A-Za-z0-9_]+$');
COMMENT ON COLUMN "avisos"."regla_aviso"."rol_desde_campo" IS 'Si no es nulo, el aviso es para las cuentas activas con el rol que trae el evento en data.<campo> (rol_codigo queda como marca); si el evento trae `asignados`, para esas cuentas.';
