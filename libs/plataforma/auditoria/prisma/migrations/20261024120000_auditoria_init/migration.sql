-- Auditoría: registro central e inmutable de los hechos de negocio (proyección de los eventos de todos los contenedores).
CREATE TYPE "origen_evento" AS ENUM ('comercial', 'operaciones', 'flota', 'qhse', 'plataforma', 'worker');

CREATE TABLE "tipo_evento" (
    "id" UUID NOT NULL,
    "codigo" TEXT NOT NULL,
    "creado_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "tipo_evento_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "tipo_evento_codigo_formato" CHECK ("codigo" ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2,}$')
);
CREATE UNIQUE INDEX "tipo_evento_codigo_key" ON "tipo_evento"("codigo");
COMMENT ON TABLE "tipo_evento" IS 'Catálogo de tipos de evento (<contenedor>.<entidad>.<hecho>). Alta automática al llegar el primero.';

CREATE TABLE "sujeto_tipo" (
    "id" UUID NOT NULL,
    "codigo" TEXT NOT NULL,
    "creado_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "sujeto_tipo_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "sujeto_tipo_codigo_formato" CHECK ("codigo" ~ '^[a-z][a-z0-9_]*$')
);
CREATE UNIQUE INDEX "sujeto_tipo_codigo_key" ON "sujeto_tipo"("codigo");
COMMENT ON TABLE "sujeto_tipo" IS 'Catálogo de tipos de entidad sobre las que ocurren los hechos (pedido, pumping_ticket...). Alta automática.';

CREATE TABLE "clave_dato" (
    "id" UUID NOT NULL,
    "codigo" TEXT NOT NULL,
    "descripcion" TEXT NOT NULL,
    CONSTRAINT "clave_dato_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "clave_dato_codigo_formato" CHECK ("codigo" ~ '^[a-z][a-z0-9_]*$')
);
CREATE UNIQUE INDEX "clave_dato_codigo_key" ON "clave_dato"("codigo");
COMMENT ON TABLE "clave_dato" IS 'Lista blanca de claves de negocio que se extraen del evento para buscarlo (la sembrada por la semilla).';

CREATE TABLE "evento_auditado" (
    "id" UUID NOT NULL,
    "tipo_evento_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "ocurrido_at" TIMESTAMPTZ(6) NOT NULL,
    "origen" "origen_evento" NOT NULL,
    "sujeto_tipo_id" UUID NOT NULL,
    "sujeto_id" UUID NOT NULL,
    "actor_id" UUID,
    "actor_rol_id" UUID,
    "correlacion_id" UUID,
    "causa_id" UUID,
    "registrado_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "evento_auditado_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "evento_auditado_version_positiva" CHECK ("version" >= 1),
    -- el rol con que actuó solo tiene sentido si se conoce quién actuó
    CONSTRAINT "evento_auditado_rol_requiere_actor" CHECK ("actor_rol_id" IS NULL OR "actor_id" IS NOT NULL),
    CONSTRAINT "evento_auditado_tipo_evento_id_fkey" FOREIGN KEY ("tipo_evento_id") REFERENCES "tipo_evento"("id"),
    CONSTRAINT "evento_auditado_sujeto_tipo_id_fkey" FOREIGN KEY ("sujeto_tipo_id") REFERENCES "sujeto_tipo"("id"),
    CONSTRAINT "evento_auditado_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES identidad.usuario("id"),
    CONSTRAINT "evento_auditado_actor_rol_id_fkey" FOREIGN KEY ("actor_rol_id") REFERENCES identidad.rol("id")
);
CREATE INDEX "evento_auditado_sujeto_idx" ON "evento_auditado"("sujeto_tipo_id", "sujeto_id", "ocurrido_at");
CREATE INDEX "evento_auditado_actor_idx" ON "evento_auditado"("actor_id", "ocurrido_at");
CREATE INDEX "evento_auditado_tipo_idx" ON "evento_auditado"("tipo_evento_id", "ocurrido_at");
CREATE INDEX "evento_auditado_ocurrido_idx" ON "evento_auditado"("ocurrido_at");
COMMENT ON TABLE "evento_auditado" IS 'Hecho de negocio proyectado desde un evento. Inmutable: sin UPDATE ni DELETE. Sin el cuerpo del evento.';
COMMENT ON COLUMN "evento_auditado"."id" IS 'Id del evento (UUIDv7 del productor): llave de idempotencia de la proyección.';
COMMENT ON COLUMN "evento_auditado"."sujeto_id" IS 'Id de la entidad afectada. Es de otro contenedor (comercial, operaciones, qhse...): sin FK.';
COMMENT ON COLUMN "evento_auditado"."actor_id" IS 'Cuenta que actuó (FK a identidad.usuario). Nulo si lo hizo el sistema o el productor no informó la cuenta.';
COMMENT ON COLUMN "evento_auditado"."correlacion_id" IS 'Id que une los eventos de una misma operación. Viene del evento; sin FK.';
COMMENT ON COLUMN "evento_auditado"."causa_id" IS 'Id del evento que provocó este. Viene del evento; sin FK.';

CREATE TABLE "evento_auditado_dato" (
    "evento_id" UUID NOT NULL,
    "clave_dato_id" UUID NOT NULL,
    "valor" TEXT NOT NULL,
    CONSTRAINT "evento_auditado_dato_pkey" PRIMARY KEY ("evento_id", "clave_dato_id"),
    CONSTRAINT "evento_auditado_dato_valor_largo" CHECK (length("valor") BETWEEN 1 AND 200),
    CONSTRAINT "evento_auditado_dato_evento_id_fkey" FOREIGN KEY ("evento_id") REFERENCES "evento_auditado"("id"),
    CONSTRAINT "evento_auditado_dato_clave_dato_id_fkey" FOREIGN KEY ("clave_dato_id") REFERENCES "clave_dato"("id")
);
CREATE INDEX "evento_auditado_dato_clave_valor_idx" ON "evento_auditado_dato"("clave_dato_id", "valor");
COMMENT ON TABLE "evento_auditado_dato" IS 'Claves de negocio del evento (lista blanca de clave_dato). Inmutable.';
COMMENT ON COLUMN "evento_auditado_dato"."valor" IS 'Valor tal como lo informó el productor; los ids son de otros contenedores (sin FK).';

-- Inmutabilidad. La aplicación (app_plataforma) ya solo tiene SELECT e INSERT sobre este schema (infra/db/init/02-schemas.sql);
-- el trigger es una segunda defensa por si alguien amplía el privilegio. dyn_migrator (dueño del DDL, nunca la aplicación) queda
-- fuera para que las pruebas puedan limpiar sus propios registros.
CREATE FUNCTION auditoria.rechazar_cambio_de_historia() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'dyn_migrator' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  RAISE EXCEPTION 'La auditoría es inmutable: no se permite % en %.%', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "evento_auditado_inmutable" BEFORE UPDATE OR DELETE ON "evento_auditado"
  FOR EACH ROW EXECUTE FUNCTION auditoria.rechazar_cambio_de_historia();
CREATE TRIGGER "evento_auditado_dato_inmutable" BEFORE UPDATE OR DELETE ON "evento_auditado_dato"
  FOR EACH ROW EXECUTE FUNCTION auditoria.rechazar_cambio_de_historia();
