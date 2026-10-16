-- CreateTable
CREATE TABLE "permiso" (
    "id" UUID NOT NULL,
    "codigo" TEXT NOT NULL,
    "modulo" TEXT NOT NULL,
    "recurso" TEXT NOT NULL,
    "accion" TEXT NOT NULL,
    "descripcion" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "permiso_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rol_permiso" (
    "rol_id" UUID NOT NULL,
    "permiso_id" UUID NOT NULL,
    "asignado_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "asignado_por" UUID,

    CONSTRAINT "rol_permiso_pkey" PRIMARY KEY ("rol_id","permiso_id")
);

-- CreateTable
CREATE TABLE "rol_permiso_historial" (
    "id" UUID NOT NULL,
    "rol_id" UUID NOT NULL,
    "permiso_codigo" TEXT NOT NULL,
    "accion" TEXT NOT NULL,
    "realizado_por" UUID,
    "realizado_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rol_permiso_historial_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "permiso_codigo_key" ON "permiso"("codigo");

-- CreateIndex
CREATE INDEX "permiso_modulo_idx" ON "permiso"("modulo");

-- CreateIndex
CREATE INDEX "rol_permiso_permiso_id_idx" ON "rol_permiso"("permiso_id");

-- CreateIndex
CREATE INDEX "rol_permiso_historial_rol_id_realizado_at_idx" ON "rol_permiso_historial"("rol_id", "realizado_at" DESC);

-- AddForeignKey
ALTER TABLE "rol_permiso" ADD CONSTRAINT "rol_permiso_rol_id_fkey" FOREIGN KEY ("rol_id") REFERENCES "rol"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rol_permiso" ADD CONSTRAINT "rol_permiso_permiso_id_fkey" FOREIGN KEY ("permiso_id") REFERENCES "permiso"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rol_permiso" ADD CONSTRAINT "rol_permiso_asignado_por_fkey" FOREIGN KEY ("asignado_por") REFERENCES "usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rol_permiso_historial" ADD CONSTRAINT "rol_permiso_historial_rol_id_fkey" FOREIGN KEY ("rol_id") REFERENCES "rol"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rol_permiso_historial" ADD CONSTRAINT "rol_permiso_historial_realizado_por_fkey" FOREIGN KEY ("realizado_por") REFERENCES "usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Reglas y privilegios que Prisma no expresa --------------------------------------------------------

ALTER TABLE "rol_permiso_historial" ADD CONSTRAINT "rol_permiso_historial_accion_check"
  CHECK ("accion" IN ('otorgado', 'revocado'));

-- Reemplazar el conjunto de permisos de un rol implica quitar filas: DELETE solo en esta tabla
-- (las demás de identidad siguen sin DELETE para la aplicación).
GRANT DELETE ON "rol_permiso" TO app_plataforma;

-- La bitácora es de solo inserción: ni UPDATE ni DELETE (como auditoria.evento).
REVOKE UPDATE ON "rol_permiso_historial" FROM app_plataforma;

COMMENT ON TABLE "permiso" IS 'Catálogo de permisos (RBAC): <modulo>.<recurso>.<accion>. Lo define el código; la app solo los asigna a roles.';
COMMENT ON TABLE "rol_permiso" IS 'Qué puede hacer cada rol. Editable por un administrador desde la app.';
COMMENT ON TABLE "rol_permiso_historial" IS 'Bitácora inmutable de cambios de permisos de un rol (otorgado/revocado, quién y cuándo).';
