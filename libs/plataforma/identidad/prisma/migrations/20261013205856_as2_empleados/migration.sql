-- AlterTable
ALTER TABLE "usuario_perfil" ADD COLUMN     "empleado_as2_id" UUID;

-- CreateTable
CREATE TABLE "empleado_as2" (
    "id" UUID NOT NULL,
    "as2_empleado_id" INTEGER NOT NULL,
    "cedula" TEXT NOT NULL,
    "nombres" TEXT NOT NULL,
    "apellidos" TEXT NOT NULL,
    "genero" TEXT,
    "cargo" TEXT,
    "departamento" TEXT,
    "sucursal" TEXT,
    "tipo_contrato" TEXT,
    "fecha_ingreso" DATE,
    "fecha_salida" DATE,
    "activo" BOOLEAN NOT NULL,
    "correo_as2" TEXT,
    "sincronizado_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "empleado_as2_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "empleado_as2_historial" (
    "id" UUID NOT NULL,
    "empleado_id" UUID NOT NULL,
    "campo" TEXT NOT NULL,
    "valor_anterior" TEXT,
    "valor_nuevo" TEXT,
    "detectado_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ejecucion_id" UUID,

    CONSTRAINT "empleado_as2_historial_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sincronizacion_as2" (
    "id" UUID NOT NULL,
    "iniciada_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finalizada_at" TIMESTAMPTZ(6),
    "estado" TEXT NOT NULL,
    "origen" TEXT NOT NULL,
    "disparada_por" UUID,
    "leidos" INTEGER NOT NULL DEFAULT 0,
    "nuevos" INTEGER NOT NULL DEFAULT 0,
    "modificados" INTEGER NOT NULL DEFAULT 0,
    "bajas" INTEGER NOT NULL DEFAULT 0,
    "cuentas_inactivadas" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,

    CONSTRAINT "sincronizacion_as2_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "empleado_as2_as2_empleado_id_key" ON "empleado_as2"("as2_empleado_id");

-- CreateIndex
CREATE INDEX "empleado_as2_cedula_idx" ON "empleado_as2"("cedula");

-- CreateIndex
CREATE INDEX "empleado_as2_activo_idx" ON "empleado_as2"("activo");

-- CreateIndex
CREATE INDEX "empleado_as2_historial_empleado_id_detectado_at_idx" ON "empleado_as2_historial"("empleado_id", "detectado_at" DESC);

-- CreateIndex
CREATE INDEX "sincronizacion_as2_iniciada_at_idx" ON "sincronizacion_as2"("iniciada_at" DESC);

-- CreateIndex
CREATE INDEX "usuario_perfil_empleado_as2_id_idx" ON "usuario_perfil"("empleado_as2_id");

-- AddForeignKey
ALTER TABLE "usuario_perfil" ADD CONSTRAINT "usuario_perfil_empleado_as2_id_fkey" FOREIGN KEY ("empleado_as2_id") REFERENCES "empleado_as2"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "empleado_as2_historial" ADD CONSTRAINT "empleado_as2_historial_empleado_id_fkey" FOREIGN KEY ("empleado_id") REFERENCES "empleado_as2"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "empleado_as2_historial" ADD CONSTRAINT "empleado_as2_historial_ejecucion_id_fkey" FOREIGN KEY ("ejecucion_id") REFERENCES "sincronizacion_as2"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Reglas y privilegios que Prisma no expresa --------------------------------------------------------

ALTER TABLE "sincronizacion_as2" ADD CONSTRAINT "sincronizacion_as2_estado_check"
  CHECK ("estado" IN ('en_curso', 'ok', 'error'));
ALTER TABLE "sincronizacion_as2" ADD CONSTRAINT "sincronizacion_as2_origen_check"
  CHECK ("origen" IN ('manual', 'programada'));

-- La bitácora es de solo inserción: ni UPDATE ni DELETE (como rol_permiso_historial).
REVOKE UPDATE ON "empleado_as2_historial" FROM app_plataforma;

COMMENT ON TABLE "empleado_as2" IS 'Copia local de solo lectura de los empleados de AS2 (ERP). Sin sueldo, discapacidad ni cargas. La alimenta la sincronización.';
COMMENT ON COLUMN "empleado_as2"."fecha_salida" IS 'Nula = activo. Es la única señal de baja; que falte en la respuesta de AS2 no inactiva a nadie.';
COMMENT ON TABLE "empleado_as2_historial" IS 'Bitácora inmutable de cambios de cada empleado de AS2 (una fila por campo).';
COMMENT ON TABLE "sincronizacion_as2" IS 'Corridas de la sincronización con AS2: conteos y error, si lo hubo.';
