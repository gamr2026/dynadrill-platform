-- CreateTable
CREATE TABLE "proveedor" (
    "id" UUID NOT NULL,
    "codigo" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "base_url" TEXT NOT NULL,
    "ambiente" TEXT NOT NULL,
    "formato" TEXT NOT NULL DEFAULT 'json',
    "timeout_ms" INTEGER NOT NULL DEFAULT 30000,
    "reintentos" INTEGER NOT NULL DEFAULT 1,
    "variables" JSONB NOT NULL DEFAULT '{}',
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,

    CONSTRAINT "proveedor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "autenticacion" (
    "id" UUID NOT NULL,
    "proveedor_id" UUID NOT NULL,
    "tipo" TEXT NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "secretos" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "autenticacion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "operacion" (
    "id" UUID NOT NULL,
    "proveedor_id" UUID NOT NULL,
    "codigo" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "activa" BOOLEAN NOT NULL DEFAULT false,
    "descripcion" TEXT,
    "metodo" TEXT NOT NULL DEFAULT 'POST',
    "ruta" TEXT NOT NULL,
    "cabeceras" JSONB,
    "cuerpo" JSONB,
    "paginacion" JSONB,
    "ruta_resultados" TEXT NOT NULL DEFAULT '',
    "requiere_auth" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "operacion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mapeo_campo" (
    "id" UUID NOT NULL,
    "operacion_id" UUID NOT NULL,
    "destino" TEXT NOT NULL,
    "origen" TEXT NOT NULL,
    "transformacion" TEXT,
    "obligatorio" BOOLEAN NOT NULL DEFAULT false,
    "orden" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "mapeo_campo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ejecucion" (
    "id" UUID NOT NULL,
    "operacion_id" UUID NOT NULL,
    "iniciada_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "duracion_ms" INTEGER NOT NULL,
    "estado" TEXT NOT NULL,
    "http_status" INTEGER,
    "registros" INTEGER NOT NULL DEFAULT 0,
    "omitidos" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "solicitado_por" TEXT,

    CONSTRAINT "ejecucion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cambio" (
    "id" UUID NOT NULL,
    "entidad" TEXT NOT NULL,
    "entidad_id" UUID NOT NULL,
    "accion" TEXT NOT NULL,
    "antes" JSONB,
    "despues" JSONB,
    "realizado_por" UUID,
    "realizado_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cambio_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "proveedor_codigo_key" ON "proveedor"("codigo");

-- CreateIndex
CREATE UNIQUE INDEX "autenticacion_proveedor_id_key" ON "autenticacion"("proveedor_id");

-- CreateIndex
CREATE UNIQUE INDEX "operacion_proveedor_id_codigo_version_key" ON "operacion"("proveedor_id", "codigo", "version");

-- CreateIndex
CREATE UNIQUE INDEX "mapeo_campo_operacion_id_destino_key" ON "mapeo_campo"("operacion_id", "destino");

-- CreateIndex
CREATE INDEX "ejecucion_operacion_id_iniciada_at_idx" ON "ejecucion"("operacion_id", "iniciada_at" DESC);

-- CreateIndex
CREATE INDEX "ejecucion_iniciada_at_idx" ON "ejecucion"("iniciada_at" DESC);

-- CreateIndex
CREATE INDEX "cambio_entidad_entidad_id_realizado_at_idx" ON "cambio"("entidad", "entidad_id", "realizado_at" DESC);

-- AddForeignKey
ALTER TABLE "autenticacion" ADD CONSTRAINT "autenticacion_proveedor_id_fkey" FOREIGN KEY ("proveedor_id") REFERENCES "proveedor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operacion" ADD CONSTRAINT "operacion_proveedor_id_fkey" FOREIGN KEY ("proveedor_id") REFERENCES "proveedor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mapeo_campo" ADD CONSTRAINT "mapeo_campo_operacion_id_fkey" FOREIGN KEY ("operacion_id") REFERENCES "operacion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ejecucion" ADD CONSTRAINT "ejecucion_operacion_id_fkey" FOREIGN KEY ("operacion_id") REFERENCES "operacion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Reglas y privilegios que Prisma no expresa --------------------------------------------------------

ALTER TABLE "proveedor" ADD CONSTRAINT "proveedor_ambiente_check" CHECK ("ambiente" IN ('produccion', 'pruebas'));
ALTER TABLE "proveedor" ADD CONSTRAINT "proveedor_timeout_check" CHECK ("timeout_ms" BETWEEN 1000 AND 300000);
ALTER TABLE "proveedor" ADD CONSTRAINT "proveedor_reintentos_check" CHECK ("reintentos" BETWEEN 0 AND 5);
ALTER TABLE "proveedor" ADD CONSTRAINT "proveedor_codigo_check" CHECK ("codigo" ~ '^[a-z][a-z0-9_]*$');

ALTER TABLE "autenticacion" ADD CONSTRAINT "autenticacion_tipo_check"
  CHECK ("tipo" IN ('ninguna', 'bearer_login', 'api_key'));

ALTER TABLE "operacion" ADD CONSTRAINT "operacion_metodo_check" CHECK ("metodo" IN ('GET', 'POST', 'PUT', 'PATCH'));
ALTER TABLE "operacion" ADD CONSTRAINT "operacion_codigo_check" CHECK ("codigo" ~ '^[a-z][a-z0-9_]*$');
ALTER TABLE "operacion" ADD CONSTRAINT "operacion_version_check" CHECK ("version" >= 1);
-- Solo una versión activa por proveedor y código: activar una nueva exige desactivar la anterior (en una transacción).
CREATE UNIQUE INDEX "operacion_una_activa_idx" ON "operacion" ("proveedor_id", "codigo") WHERE "activa";

ALTER TABLE "mapeo_campo" ADD CONSTRAINT "mapeo_campo_transformacion_check"
  CHECK ("transformacion" IS NULL OR "transformacion" IN ('texto', 'entero', 'numero', 'booleano', 'fecha_ms_ec', 'fecha_iso'));

ALTER TABLE "ejecucion" ADD CONSTRAINT "ejecucion_estado_check" CHECK ("estado" IN ('ok', 'error'));

-- Bitácoras de solo inserción: ni UPDATE ni DELETE para la aplicación.
REVOKE UPDATE ON "ejecucion" FROM app_plataforma;
REVOKE UPDATE ON "cambio" FROM app_plataforma;

COMMENT ON TABLE "proveedor" IS 'Terceros con los que nos integramos: URL base, ambiente, formato, tiempos y variables no secretas.';
COMMENT ON TABLE "autenticacion" IS 'Cómo se autentica el motor ante cada proveedor. Guarda el NOMBRE de los secretos, nunca su valor.';
COMMENT ON TABLE "operacion" IS 'Llamadas versionadas a un proveedor (ruta, plantillas, paginación). Una sola versión activa por código.';
COMMENT ON TABLE "mapeo_campo" IS 'Traducción de cada campo de la respuesta del tercero a nuestro modelo.';
COMMENT ON TABLE "ejecucion" IS 'Bitácora inmutable de cada llamada: estado, tiempos y conteos. Sin cuerpos ni datos personales.';
COMMENT ON TABLE "cambio" IS 'Bitácora inmutable de los cambios de configuración de integraciones.';
