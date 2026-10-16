-- CreateEnum
CREATE TYPE "escaneo" AS ENUM ('limpio', 'omitido');

-- CreateTable
CREATE TABLE "modulo_archivo" (
    "id" UUID NOT NULL,
    "codigo" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "permiso_subir" TEXT NOT NULL,
    "permiso_ver" TEXT NOT NULL,
    "tipos_mime" TEXT[],
    "tamano_max_mb" INTEGER NOT NULL DEFAULT 25,
    "activo" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "modulo_archivo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "archivo" (
    "id" UUID NOT NULL,
    "modulo_id" UUID NOT NULL,
    "nombre_original" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "tamano_bytes" BIGINT NOT NULL,
    "sha256" TEXT NOT NULL,
    "blob_key" TEXT NOT NULL,
    "escaneo" "escaneo" NOT NULL,
    "subido_por" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "eliminado_at" TIMESTAMPTZ(6),
    "eliminado_por" UUID,

    CONSTRAINT "archivo_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "modulo_archivo_codigo_key" ON "modulo_archivo"("codigo");
CREATE UNIQUE INDEX "archivo_blob_key_key" ON "archivo"("blob_key");
CREATE INDEX "archivo_modulo_id_created_at_idx" ON "archivo"("modulo_id", "created_at" DESC);
CREATE INDEX "archivo_sha256_idx" ON "archivo"("sha256");

-- AddForeignKey
ALTER TABLE "archivo" ADD CONSTRAINT "archivo_modulo_id_fkey" FOREIGN KEY ("modulo_id") REFERENCES "modulo_archivo"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Reglas que Prisma no expresa
ALTER TABLE "archivo" ADD CONSTRAINT "archivo_tamano_check" CHECK ("tamano_bytes" > 0);
ALTER TABLE "archivo" ADD CONSTRAINT "archivo_sha256_check" CHECK ("sha256" ~ '^[0-9a-f]{64}$');
ALTER TABLE "archivo" ADD CONSTRAINT "archivo_baja_check"
  CHECK (("eliminado_at" IS NULL) = ("eliminado_por" IS NULL));
ALTER TABLE "modulo_archivo" ADD CONSTRAINT "modulo_archivo_tamano_check" CHECK ("tamano_max_mb" BETWEEN 1 AND 200);

-- El registro de un archivo es inmutable salvo su baja lógica: la aplicación solo puede actualizar las columnas de baja.
REVOKE UPDATE ON "archivo" FROM app_plataforma;
GRANT UPDATE ("eliminado_at", "eliminado_por") ON "archivo" TO app_plataforma;

COMMENT ON TABLE "modulo_archivo" IS 'Qué admite cada módulo que guarda archivos: permisos, tipos de contenido y tamaño.';
COMMENT ON TABLE "archivo" IS 'Registro de cada archivo guardado; el contenido vive en el almacenamiento de objetos (blob_key).';
