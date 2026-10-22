-- Firmas: evidencia inmutable de las firmas de los documentos de los demás módulos.
CREATE TYPE "metodo_firma" AS ENUM ('linea', 'electronica', 'manuscrita');
CREATE TYPE "resultado_verificacion_firma" AS ENUM ('firma_detectada', 'firma_no_detectada', 'no_concluyente');

CREATE TABLE "documento_tipo" (
    "id" UUID NOT NULL,
    "codigo" TEXT NOT NULL,
    "descripcion" TEXT NOT NULL,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "documento_tipo_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "documento_tipo_codigo_formato" CHECK ("codigo" ~ '^[a-z][a-z0-9_]*$')
);
CREATE UNIQUE INDEX "documento_tipo_codigo_key" ON "documento_tipo"("codigo");
COMMENT ON TABLE "documento_tipo" IS 'Documentos que se firman. Un tipo desconocido se rechaza: define qué cuenta como firma.';

CREATE TABLE "rol_firmante" (
    "id" UUID NOT NULL,
    "codigo" TEXT NOT NULL,
    "descripcion" TEXT NOT NULL,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "rol_firmante_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "rol_firmante_codigo_formato" CHECK ("codigo" ~ '^[a-z][a-z0-9_]*$')
);
CREATE UNIQUE INDEX "rol_firmante_codigo_key" ON "rol_firmante"("codigo");
COMMENT ON TABLE "rol_firmante" IS 'Papel de quien firma dentro del documento (trabajador, talento humano, revisado por...). No es el rol de la cuenta.';

CREATE TABLE "firma" (
    "id" UUID NOT NULL,
    "evento_id" UUID NOT NULL,
    "documento_tipo_id" UUID NOT NULL,
    "documento_id" UUID NOT NULL,
    "rol_firmante_id" UUID NOT NULL,
    "firmante_id" UUID NOT NULL,
    "firmada_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metodo" "metodo_firma" NOT NULL,
    "archivo_id" UUID,
    "hash_documento" TEXT,
    CONSTRAINT "firma_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "firma_hash_formato" CHECK ("hash_documento" IS NULL OR "hash_documento" ~ '^[0-9a-f]{64}$'),
    -- «de una línea»: la huella del texto firmado y ningún archivo; electrónica y manuscrita: el archivo (su huella sale de archivos.archivo)
    CONSTRAINT "firma_metodo_coherente" CHECK (
      ("metodo" = 'linea' AND "archivo_id" IS NULL AND "hash_documento" IS NOT NULL)
      OR ("metodo" <> 'linea' AND "archivo_id" IS NOT NULL AND "hash_documento" IS NULL)
    ),
    CONSTRAINT "firma_documento_tipo_id_fkey" FOREIGN KEY ("documento_tipo_id") REFERENCES "documento_tipo"("id"),
    CONSTRAINT "firma_rol_firmante_id_fkey" FOREIGN KEY ("rol_firmante_id") REFERENCES "rol_firmante"("id"),
    CONSTRAINT "firma_firmante_id_fkey" FOREIGN KEY ("firmante_id") REFERENCES identidad.usuario("id"),
    CONSTRAINT "firma_archivo_id_fkey" FOREIGN KEY ("archivo_id") REFERENCES archivos.archivo("id")
);
CREATE UNIQUE INDEX "firma_evento_id_key" ON "firma"("evento_id");
CREATE INDEX "firma_documento_idx" ON "firma"("documento_tipo_id", "documento_id", "rol_firmante_id", "firmada_at" DESC);
CREATE INDEX "firma_firmante_idx" ON "firma"("firmante_id", "firmada_at" DESC);
COMMENT ON TABLE "firma" IS 'Firma de un documento. Inmutable: una corrección es una firma nueva y vale la más reciente por documento y papel.';
COMMENT ON COLUMN "firma"."evento_id" IS 'Id del evento <contenedor>.<documento>.firmado que la originó: llave de idempotencia y enlace con auditoría.';
COMMENT ON COLUMN "firma"."documento_id" IS 'Id del documento firmado. Es de otro contenedor (qhse, operaciones, comercial): sin FK.';
COMMENT ON COLUMN "firma"."firmante_id" IS 'Cuenta que firmó (FK a identidad.usuario): la del actor del evento, nunca un dato libre.';
COMMENT ON COLUMN "firma"."firmada_at" IS 'Hora del servidor al registrar la firma.';
COMMENT ON COLUMN "firma"."hash_documento" IS 'SHA-256 (hex) del documento o texto firmado, solo en la firma de una línea. En las firmas con archivo la huella es archivos.archivo.sha256.';

CREATE TABLE "firma_verificacion" (
    "id" UUID NOT NULL,
    "firma_id" UUID NOT NULL,
    "resultado" "resultado_verificacion_firma" NOT NULL,
    "confianza" NUMERIC(4,3) NOT NULL,
    "nombre_coincide" BOOLEAN,
    "verificada_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "solicitada_por" UUID NOT NULL,
    CONSTRAINT "firma_verificacion_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "firma_verificacion_confianza_rango" CHECK ("confianza" >= 0 AND "confianza" <= 1),
    CONSTRAINT "firma_verificacion_firma_id_fkey" FOREIGN KEY ("firma_id") REFERENCES "firma"("id"),
    CONSTRAINT "firma_verificacion_solicitada_por_fkey" FOREIGN KEY ("solicitada_por") REFERENCES identidad.usuario("id")
);
CREATE INDEX "firma_verificacion_firma_idx" ON "firma_verificacion"("firma_id", "verificada_at" DESC);
COMMENT ON TABLE "firma_verificacion" IS 'Intento de leer la firma del archivo firmado (ayuda para revisar; no certifica la autenticidad). Solo se agrega: vale el más reciente.';

-- Historia inmutable: la aplicación (por defecto con SELECT, INSERT y UPDATE sobre este schema) pierde UPDATE y DELETE sobre las
-- tablas de evidencia; los catálogos siguen editables. El trigger es una segunda defensa: dyn_migrator (dueño del DDL, nunca la
-- aplicación) solo queda exento con el ajuste de sesión explícito que usan las pruebas de integración para limpiar lo suyo.
REVOKE UPDATE, DELETE ON "firma", "firma_verificacion" FROM app_plataforma;

CREATE FUNCTION firmas.rechazar_cambio_de_historia() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'dyn_migrator' AND current_setting('firmas.limpieza_de_pruebas', true) = 'on' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  RAISE EXCEPTION 'Las firmas son inmutables: no se permite % en %.%', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "firma_inmutable" BEFORE UPDATE OR DELETE ON "firma"
  FOR EACH ROW EXECUTE FUNCTION firmas.rechazar_cambio_de_historia();
CREATE TRIGGER "firma_verificacion_inmutable" BEFORE UPDATE OR DELETE ON "firma_verificacion"
  FOR EACH ROW EXECUTE FUNCTION firmas.rechazar_cambio_de_historia();
