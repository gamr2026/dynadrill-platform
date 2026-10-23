-- Encuestas (contenedor plataforma, sección de administración): plantillas de encuesta versionadas, preguntas con tipo de respuesta,
-- invitaciones de un solo uso y respuestas en filas. Sirve a cualquier módulo (la primera es la encuesta de satisfacción de FCR).

-- El schema lo crea la inicialización de la base (infra/db/init/02-schemas.sql): dyn_migrator no puede crear schemas.
-- Aquí se conceden los privilegios del contenedor.
GRANT USAGE ON SCHEMA "encuestas" TO app_plataforma;
-- Tablas de negocio: SELECT, INSERT, UPDATE (como el resto de schemas de plataforma). Lo que no se edita se revoca tabla por tabla.
ALTER DEFAULT PRIVILEGES FOR ROLE dyn_migrator IN SCHEMA "encuestas" GRANT SELECT, INSERT, UPDATE ON TABLES TO app_plataforma;

CREATE TYPE "encuestas"."tipo_respuesta" AS ENUM ('escala', 'texto', 'si_no', 'opcion_unica', 'opcion_multiple');
CREATE TYPE "encuestas"."estado_version" AS ENUM ('borrador', 'publicada', 'archivada');

-- ---------------------------------------------------------------------------------------------------------------
-- Catálogos
-- ---------------------------------------------------------------------------------------------------------------
-- Módulo del sistema al que sirve una encuesta (se siembra: `fcr`).
CREATE TABLE "encuestas"."modulo_encuesta" (
    "codigo" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "modulo_encuesta_pkey" PRIMARY KEY ("codigo"),
    CONSTRAINT "modulo_encuesta_codigo_check" CHECK ("codigo" ~ '^[a-z][a-z0-9_]*$')
);
COMMENT ON TABLE "encuestas"."modulo_encuesta" IS 'Módulos del sistema que pueden tener encuestas (código estable: lo usan los consumidores de eventos).';

-- Escalas de calificación (por ejemplo 1 a 5 con sus etiquetas).
CREATE TABLE "encuestas"."escala" (
    "id" UUID NOT NULL,
    "codigo" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    CONSTRAINT "escala_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "escala_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "escala_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id")
);
CREATE UNIQUE INDEX "escala_codigo_key" ON "encuestas"."escala" ("codigo");

CREATE TABLE "encuestas"."escala_valor" (
    "escala_id" UUID NOT NULL,
    "valor" SMALLINT NOT NULL,
    "etiqueta" TEXT NOT NULL,
    CONSTRAINT "escala_valor_pkey" PRIMARY KEY ("escala_id", "valor"),
    CONSTRAINT "escala_valor_escala_fkey" FOREIGN KEY ("escala_id") REFERENCES "encuestas"."escala" ("id") ON DELETE CASCADE,
    CONSTRAINT "escala_valor_etiqueta_check" CHECK (length(btrim("etiqueta")) > 0)
);

-- ---------------------------------------------------------------------------------------------------------------
-- Plantillas de encuesta y sus versiones
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE "encuestas"."encuesta" (
    "id" UUID NOT NULL,
    "codigo" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "modulo_codigo" TEXT NOT NULL,
    "activa" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    CONSTRAINT "encuesta_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "encuesta_modulo_fkey" FOREIGN KEY ("modulo_codigo") REFERENCES "encuestas"."modulo_encuesta" ("codigo"),
    CONSTRAINT "encuesta_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "encuesta_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "encuesta_codigo_check" CHECK ("codigo" ~ '^[a-z][a-z0-9_]*$'),
    CONSTRAINT "encuesta_nombre_check" CHECK (length(btrim("nombre")) > 0)
);
CREATE UNIQUE INDEX "encuesta_codigo_key" ON "encuestas"."encuesta" ("codigo");
CREATE INDEX "encuesta_modulo_idx" ON "encuestas"."encuesta" ("modulo_codigo");
COMMENT ON COLUMN "encuestas"."encuesta"."created_by" IS 'Quien la creó (identidad.usuario). Nulo si la sembró el sistema.';

-- Una versión es lo que se envía. Publicada, no se edita: un cambio crea una versión nueva, y así las respuestas viejas conservan sus preguntas.
CREATE TABLE "encuestas"."encuesta_version" (
    "id" UUID NOT NULL,
    "encuesta_id" UUID NOT NULL,
    "numero" INTEGER NOT NULL,
    "estado" "encuestas"."estado_version" NOT NULL DEFAULT 'borrador',
    "titulo" TEXT NOT NULL,
    "introduccion" TEXT,
    "publicada_at" TIMESTAMPTZ(6),
    "publicada_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    CONSTRAINT "encuesta_version_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "encuesta_version_encuesta_fkey" FOREIGN KEY ("encuesta_id") REFERENCES "encuestas"."encuesta" ("id"),
    CONSTRAINT "encuesta_version_publicada_by_fkey" FOREIGN KEY ("publicada_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "encuesta_version_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "encuesta_version_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "encuesta_version_numero_check" CHECK ("numero" > 0),
    CONSTRAINT "encuesta_version_titulo_check" CHECK (length(btrim("titulo")) > 0),
    -- un borrador no tiene fecha de publicación; una versión publicada o archivada sí, con quién la publicó
    CONSTRAINT "encuesta_version_publicacion_check" CHECK (
      ("estado" = 'borrador' AND "publicada_at" IS NULL AND "publicada_by" IS NULL)
      OR ("estado" <> 'borrador' AND "publicada_at" IS NOT NULL AND "publicada_by" IS NOT NULL)
    )
);
CREATE UNIQUE INDEX "encuesta_version_numero_key" ON "encuestas"."encuesta_version" ("encuesta_id", "numero");
-- a lo sumo un borrador y una versión vigente (publicada) por encuesta
CREATE UNIQUE INDEX "encuesta_version_un_borrador_key" ON "encuestas"."encuesta_version" ("encuesta_id") WHERE "estado" = 'borrador';
CREATE UNIQUE INDEX "encuesta_version_una_vigente_key" ON "encuestas"."encuesta_version" ("encuesta_id") WHERE "estado" = 'publicada';

CREATE TABLE "encuestas"."pregunta" (
    "id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "orden" INTEGER NOT NULL,
    "texto" TEXT NOT NULL,
    "tipo" "encuestas"."tipo_respuesta" NOT NULL,
    "obligatoria" BOOLEAN NOT NULL DEFAULT true,
    "escala_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    CONSTRAINT "pregunta_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "pregunta_version_fkey" FOREIGN KEY ("version_id") REFERENCES "encuestas"."encuesta_version" ("id") ON DELETE CASCADE,
    CONSTRAINT "pregunta_escala_fkey" FOREIGN KEY ("escala_id") REFERENCES "encuestas"."escala" ("id"),
    CONSTRAINT "pregunta_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "pregunta_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "pregunta_orden_check" CHECK ("orden" > 0),
    CONSTRAINT "pregunta_texto_check" CHECK (length(btrim("texto")) > 0),
    -- solo las preguntas de escala llevan escala
    CONSTRAINT "pregunta_escala_check" CHECK (("tipo" = 'escala') = ("escala_id" IS NOT NULL))
);
CREATE UNIQUE INDEX "pregunta_orden_key" ON "encuestas"."pregunta" ("version_id", "orden");
-- para que la opción lleve el tipo de su pregunta (FK compuesta)
CREATE UNIQUE INDEX "pregunta_id_tipo_key" ON "encuestas"."pregunta" ("id", "tipo");
CREATE INDEX "pregunta_escala_idx" ON "encuestas"."pregunta" ("escala_id");

CREATE TABLE "encuestas"."pregunta_opcion" (
    "id" UUID NOT NULL,
    "pregunta_id" UUID NOT NULL,
    "pregunta_tipo" "encuestas"."tipo_respuesta" NOT NULL,
    "orden" INTEGER NOT NULL,
    "etiqueta" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    CONSTRAINT "pregunta_opcion_pkey" PRIMARY KEY ("id"),
    -- la pregunta y su tipo van juntos: solo las de opción única o múltiple llevan opciones
    CONSTRAINT "pregunta_opcion_pregunta_fkey" FOREIGN KEY ("pregunta_id", "pregunta_tipo") REFERENCES "encuestas"."pregunta" ("id", "tipo") ON DELETE CASCADE,
    CONSTRAINT "pregunta_opcion_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "pregunta_opcion_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "pregunta_opcion_tipo_check" CHECK ("pregunta_tipo" IN ('opcion_unica', 'opcion_multiple')),
    CONSTRAINT "pregunta_opcion_orden_check" CHECK ("orden" > 0),
    CONSTRAINT "pregunta_opcion_etiqueta_check" CHECK (length(btrim("etiqueta")) > 0)
);
CREATE UNIQUE INDEX "pregunta_opcion_orden_key" ON "encuestas"."pregunta_opcion" ("pregunta_id", "orden");
-- para que la respuesta enlace una opción de SU pregunta (FK compuesta)
CREATE UNIQUE INDEX "pregunta_opcion_id_pregunta_key" ON "encuestas"."pregunta_opcion" ("id", "pregunta_id");

-- El borrador se arma y se corrige borrando preguntas y opciones; solo se concede DELETE aquí y un disparador lo limita a borradores.
GRANT DELETE ON "encuestas"."pregunta", "encuestas"."pregunta_opcion" TO app_plataforma;

-- ---------------------------------------------------------------------------------------------------------------
-- Invitaciones (el envío) y respuestas
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE "encuestas"."invitacion" (
    "id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "modulo_codigo" TEXT NOT NULL,
    "referencia_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "correo_destino" TEXT NOT NULL,
    "vence_at" TIMESTAMPTZ(6) NOT NULL,
    "enviada_at" TIMESTAMPTZ(6),
    "envio_error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    CONSTRAINT "invitacion_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "invitacion_version_fkey" FOREIGN KEY ("version_id") REFERENCES "encuestas"."encuesta_version" ("id"),
    CONSTRAINT "invitacion_modulo_fkey" FOREIGN KEY ("modulo_codigo") REFERENCES "encuestas"."modulo_encuesta" ("codigo"),
    CONSTRAINT "invitacion_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "invitacion_token_check" CHECK ("token_hash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "invitacion_correo_check" CHECK ("correo_destino" ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
    CONSTRAINT "invitacion_vigencia_check" CHECK ("vence_at" > "created_at"),
    -- el error de envío y la marca de enviada no conviven
    CONSTRAINT "invitacion_envio_check" CHECK ("enviada_at" IS NULL OR "envio_error" IS NULL)
);
CREATE UNIQUE INDEX "invitacion_token_key" ON "encuestas"."invitacion" ("token_hash");
CREATE INDEX "invitacion_referencia_idx" ON "encuestas"."invitacion" ("modulo_codigo", "referencia_id");
CREATE INDEX "invitacion_version_idx" ON "encuestas"."invitacion" ("version_id");
-- solo se actualiza el resultado del envío: la versión, el destino, el token y la vigencia no cambian
REVOKE UPDATE ON "encuestas"."invitacion" FROM app_plataforma;
GRANT UPDATE ("enviada_at", "envio_error") ON "encuestas"."invitacion" TO app_plataforma;
COMMENT ON TABLE "encuestas"."invitacion" IS 'Envío de una encuesta a un correo: enlace de un solo uso con vigencia. Solo se guarda el hash del token.';
COMMENT ON COLUMN "encuestas"."invitacion"."referencia_id" IS 'Id de lo que se evalúa (p. ej. el ticket de FCR) en OTRO contenedor: uuid sin FK.';
COMMENT ON COLUMN "encuestas"."invitacion"."token_hash" IS 'SHA-256 (hex) del token del enlace. El token en claro solo existe en el correo.';
COMMENT ON COLUMN "encuestas"."invitacion"."correo_destino" IS 'Correo del cliente que se pidió al cerrar el servicio. Dato personal: solo lo lee la administración de encuestas.';
COMMENT ON COLUMN "encuestas"."invitacion"."created_by" IS 'Quien la creó; nulo si la creó el sistema al recibir un evento.';

CREATE TABLE "encuestas"."respuesta_encuesta" (
    "id" UUID NOT NULL,
    "invitacion_id" UUID NOT NULL,
    "nombre_respondiente" TEXT NOT NULL,
    "cargo_respondiente" TEXT,
    "respondida_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "respuesta_encuesta_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "respuesta_encuesta_invitacion_fkey" FOREIGN KEY ("invitacion_id") REFERENCES "encuestas"."invitacion" ("id"),
    CONSTRAINT "respuesta_encuesta_nombre_check" CHECK (length(btrim("nombre_respondiente")) > 0)
);
-- un enlace se usa una sola vez
CREATE UNIQUE INDEX "respuesta_encuesta_invitacion_key" ON "encuestas"."respuesta_encuesta" ("invitacion_id");
COMMENT ON COLUMN "encuestas"."respuesta_encuesta"."nombre_respondiente" IS 'Quien contestó (lo escribe en el formulario; no es una cuenta del sistema).';

CREATE TABLE "encuestas"."respuesta" (
    "id" UUID NOT NULL,
    "respuesta_encuesta_id" UUID NOT NULL,
    "pregunta_id" UUID NOT NULL,
    "valor_numero" SMALLINT,
    "valor_texto" TEXT,
    "valor_booleano" BOOLEAN,
    "opcion_id" UUID,
    CONSTRAINT "respuesta_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "respuesta_encuesta_fkey" FOREIGN KEY ("respuesta_encuesta_id") REFERENCES "encuestas"."respuesta_encuesta" ("id"),
    CONSTRAINT "respuesta_pregunta_fkey" FOREIGN KEY ("pregunta_id") REFERENCES "encuestas"."pregunta" ("id"),
    -- la opción elegida es de la pregunta respondida
    CONSTRAINT "respuesta_opcion_fkey" FOREIGN KEY ("opcion_id", "pregunta_id") REFERENCES "encuestas"."pregunta_opcion" ("id", "pregunta_id"),
    -- cada fila lleva exactamente un valor
    CONSTRAINT "respuesta_un_valor_check" CHECK (
      (("valor_numero" IS NOT NULL)::int + ("valor_texto" IS NOT NULL)::int + ("valor_booleano" IS NOT NULL)::int + ("opcion_id" IS NOT NULL)::int) = 1
    ),
    CONSTRAINT "respuesta_texto_check" CHECK ("valor_texto" IS NULL OR length(btrim("valor_texto")) > 0)
);
CREATE UNIQUE INDEX "respuesta_unica_key" ON "encuestas"."respuesta" ("respuesta_encuesta_id", "pregunta_id") WHERE "opcion_id" IS NULL;
CREATE UNIQUE INDEX "respuesta_opcion_key" ON "encuestas"."respuesta" ("respuesta_encuesta_id", "pregunta_id", "opcion_id") WHERE "opcion_id" IS NOT NULL;
CREATE INDEX "respuesta_pregunta_idx" ON "encuestas"."respuesta" ("pregunta_id");
COMMENT ON TABLE "encuestas"."respuesta" IS 'Una fila por pregunta respondida (por opción elegida en la múltiple). Con exactamente un valor.';

-- lo respondido es un registro histórico: no se edita ni se borra
REVOKE UPDATE ON "encuestas"."respuesta_encuesta", "encuestas"."respuesta" FROM app_plataforma;

-- ---------------------------------------------------------------------------------------------------------------
-- Reglas que no deben depender del servicio
-- ---------------------------------------------------------------------------------------------------------------
-- Preguntas y opciones solo se tocan mientras la versión es borrador.
CREATE FUNCTION "encuestas"."exigir_version_en_borrador"() RETURNS trigger LANGUAGE plpgsql AS $$
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
  IF est IS DISTINCT FROM 'borrador' THEN
    RAISE EXCEPTION 'Una versión publicada de la encuesta no se modifica: cree una versión nueva' USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END
$$;
CREATE TRIGGER "pregunta_solo_borrador" BEFORE INSERT OR UPDATE OR DELETE ON "encuestas"."pregunta"
  FOR EACH ROW EXECUTE FUNCTION "encuestas"."exigir_version_en_borrador"();
CREATE TRIGGER "pregunta_opcion_solo_borrador" BEFORE INSERT OR UPDATE OR DELETE ON "encuestas"."pregunta_opcion"
  FOR EACH ROW EXECUTE FUNCTION "encuestas"."exigir_version_en_borrador"();

-- Recorrido de una versión: borrador → publicada → archivada. Publicada y archivada no cambian su contenido. Publicar exige preguntas completas.
CREATE FUNCTION "encuestas"."controlar_version"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."estado" = 'borrador' THEN
    IF NEW."estado" = 'archivada' THEN
      RAISE EXCEPTION 'Un borrador no se archiva: se publica o se sigue editando' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."estado" = 'publicada' THEN
      IF NOT EXISTS (SELECT 1 FROM "encuestas"."pregunta" WHERE "version_id" = NEW."id") THEN
        RAISE EXCEPTION 'La encuesta no tiene preguntas: agregue al menos una para publicarla' USING ERRCODE = 'check_violation';
      END IF;
      IF EXISTS (
        SELECT 1 FROM "encuestas"."pregunta" p
        WHERE p."version_id" = NEW."id" AND p."tipo" IN ('opcion_unica', 'opcion_multiple')
          AND (SELECT count(*) FROM "encuestas"."pregunta_opcion" o WHERE o."pregunta_id" = p."id") < 2
      ) THEN
        RAISE EXCEPTION 'Las preguntas de opción necesitan al menos dos opciones' USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF NEW."encuesta_id" <> OLD."encuesta_id" OR NEW."numero" <> OLD."numero" THEN
      RAISE EXCEPTION 'La versión no cambia de encuesta ni de número' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."encuesta_id" <> OLD."encuesta_id" OR NEW."numero" <> OLD."numero" OR NEW."titulo" <> OLD."titulo"
     OR NEW."introduccion" IS DISTINCT FROM OLD."introduccion"
     OR NEW."publicada_at" IS DISTINCT FROM OLD."publicada_at" OR NEW."publicada_by" IS DISTINCT FROM OLD."publicada_by" THEN
    RAISE EXCEPTION 'Una versión publicada de la encuesta no se modifica: cree una versión nueva' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."estado" = 'archivada' AND NEW."estado" <> 'archivada' THEN
    RAISE EXCEPTION 'Una versión archivada no vuelve a publicarse' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."estado" = 'borrador' THEN
    RAISE EXCEPTION 'Una versión publicada no vuelve a borrador' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "encuesta_version_recorrido" BEFORE UPDATE ON "encuestas"."encuesta_version"
  FOR EACH ROW EXECUTE FUNCTION "encuestas"."controlar_version"();

-- Solo se invita con una versión publicada.
CREATE FUNCTION "encuestas"."exigir_version_publicada"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "encuestas"."encuesta_version" v WHERE v."id" = NEW."version_id" AND v."estado" = 'publicada') THEN
    RAISE EXCEPTION 'Solo se envía una versión publicada de la encuesta' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "invitacion_version_publicada" BEFORE INSERT ON "encuestas"."invitacion"
  FOR EACH ROW EXECUTE FUNCTION "encuestas"."exigir_version_publicada"();

-- Se responde antes de que venza el enlace.
CREATE FUNCTION "encuestas"."exigir_enlace_vigente"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "encuestas"."invitacion" i WHERE i."id" = NEW."invitacion_id" AND i."vence_at" > CURRENT_TIMESTAMP) THEN
    RAISE EXCEPTION 'El enlace de la encuesta venció' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "respuesta_encuesta_vigente" BEFORE INSERT ON "encuestas"."respuesta_encuesta"
  FOR EACH ROW EXECUTE FUNCTION "encuestas"."exigir_enlace_vigente"();

-- Cada respuesta es de una pregunta de la versión enviada y del tipo que corresponde.
CREATE FUNCTION "encuestas"."exigir_respuesta_coherente"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  p RECORD;
  v UUID;
BEGIN
  SELECT i."version_id" INTO v
  FROM "encuestas"."respuesta_encuesta" r JOIN "encuestas"."invitacion" i ON i."id" = r."invitacion_id"
  WHERE r."id" = NEW."respuesta_encuesta_id";
  SELECT "version_id", "tipo", "escala_id" INTO p FROM "encuestas"."pregunta" WHERE "id" = NEW."pregunta_id";
  IF p."version_id" IS DISTINCT FROM v THEN
    RAISE EXCEPTION 'La pregunta no pertenece a la encuesta enviada' USING ERRCODE = 'check_violation';
  END IF;
  IF p."tipo" = 'escala' THEN
    IF NEW."valor_numero" IS NULL OR NOT EXISTS (
      SELECT 1 FROM "encuestas"."escala_valor" e WHERE e."escala_id" = p."escala_id" AND e."valor" = NEW."valor_numero"
    ) THEN
      RAISE EXCEPTION 'El valor no es parte de la escala de la pregunta' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF p."tipo" = 'texto' THEN
    IF NEW."valor_texto" IS NULL THEN RAISE EXCEPTION 'La pregunta se responde con texto' USING ERRCODE = 'check_violation'; END IF;
  ELSIF p."tipo" = 'si_no' THEN
    IF NEW."valor_booleano" IS NULL THEN RAISE EXCEPTION 'La pregunta se responde con sí o no' USING ERRCODE = 'check_violation'; END IF;
  ELSE
    IF NEW."opcion_id" IS NULL THEN RAISE EXCEPTION 'La pregunta se responde eligiendo una opción' USING ERRCODE = 'check_violation'; END IF;
    IF p."tipo" = 'opcion_unica' AND EXISTS (
      SELECT 1 FROM "encuestas"."respuesta" o WHERE o."respuesta_encuesta_id" = NEW."respuesta_encuesta_id" AND o."pregunta_id" = NEW."pregunta_id"
    ) THEN
      RAISE EXCEPTION 'La pregunta admite una sola opción' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "respuesta_coherente" BEFORE INSERT ON "encuestas"."respuesta"
  FOR EACH ROW EXECUTE FUNCTION "encuestas"."exigir_respuesta_coherente"();

-- Al terminar la transacción, toda pregunta obligatoria de la versión tiene su respuesta.
CREATE FUNCTION "encuestas"."exigir_obligatorias"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "encuestas"."invitacion" i
    JOIN "encuestas"."pregunta" p ON p."version_id" = i."version_id" AND p."obligatoria"
    WHERE i."id" = NEW."invitacion_id"
      AND NOT EXISTS (
        SELECT 1 FROM "encuestas"."respuesta" r WHERE r."respuesta_encuesta_id" = NEW."id" AND r."pregunta_id" = p."id"
      )
  ) THEN
    RAISE EXCEPTION 'Falta responder alguna pregunta obligatoria' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER "respuesta_encuesta_completa" AFTER INSERT ON "encuestas"."respuesta_encuesta"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "encuestas"."exigir_obligatorias"();
