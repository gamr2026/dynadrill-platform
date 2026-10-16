-- CreateTable
CREATE TABLE "rol" (
    "id" UUID NOT NULL,
    "codigo" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "descripcion" TEXT,

    CONSTRAINT "rol_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usuario" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "email" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "telefono" TEXT,
    "password_hash" TEXT,
    "entra_object_id" UUID,
    "rol_id" UUID NOT NULL,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "especialidad" TEXT,
    "ultimo_acceso_at" TIMESTAMPTZ(6),
    "intentos_fallidos" INTEGER NOT NULL DEFAULT 0,
    "bloqueado_hasta" TIMESTAMPTZ(6),

    CONSTRAINT "usuario_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usuario_empleado" (
    "id" UUID NOT NULL,
    "usuario_id" UUID NOT NULL,
    "cedula" TEXT,
    "tipo_identificacion" TEXT,
    "nacionalidad" TEXT,
    "apellidos" TEXT,
    "nombres" TEXT,
    "cargo" TEXT,
    "departamento" TEXT,
    "area" TEXT,
    "fecha_ingreso" DATE,
    "fecha_salida" DATE,
    "causa_salida" TEXT,
    "tipo_contrato" TEXT,
    "sucursal" TEXT,
    "tipo_discapacidad" TEXT,
    "cargas_activas" INTEGER,
    "categoria" TEXT,
    "centro_costo" TEXT,
    "empleado_activo" BOOLEAN,

    CONSTRAINT "usuario_empleado_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sesion" (
    "id" UUID NOT NULL,
    "usuario_id" UUID NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "emitido_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expira_at" TIMESTAMPTZ(6) NOT NULL,
    "revocado_at" TIMESTAMPTZ(6),
    "ip" INET,
    "user_agent" TEXT,

    CONSTRAINT "sesion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "rol_codigo_key" ON "rol"("codigo");

-- CreateIndex
CREATE UNIQUE INDEX "usuario_email_key" ON "usuario"("email");

-- CreateIndex
CREATE UNIQUE INDEX "usuario_username_key" ON "usuario"("username");

-- CreateIndex
CREATE UNIQUE INDEX "usuario_entra_object_id_key" ON "usuario"("entra_object_id");

-- CreateIndex
CREATE INDEX "usuario_rol_id_idx" ON "usuario"("rol_id");

-- CreateIndex
CREATE UNIQUE INDEX "usuario_empleado_usuario_id_key" ON "usuario_empleado"("usuario_id");

-- CreateIndex
CREATE UNIQUE INDEX "sesion_token_hash_key" ON "sesion"("token_hash");

-- CreateIndex
CREATE INDEX "sesion_usuario_id_idx" ON "sesion"("usuario_id");

-- AddForeignKey
ALTER TABLE "usuario" ADD CONSTRAINT "usuario_rol_id_fkey" FOREIGN KEY ("rol_id") REFERENCES "rol"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usuario_empleado" ADD CONSTRAINT "usuario_empleado_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuario"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sesion" ADD CONSTRAINT "sesion_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuario"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Reglas que Prisma no expresa (documento de BD: "la base valida lo que puede validar")
ALTER TABLE "usuario" ADD CONSTRAINT "usuario_especialidad_check"
  CHECK ("especialidad" IN ('Mecánico', 'Instrumental'));
ALTER TABLE "usuario" ADD CONSTRAINT "usuario_intentos_fallidos_check"
  CHECK ("intentos_fallidos" >= 0);

COMMENT ON TABLE "rol" IS 'Los 17 roles del sistema (RoleCode). La matriz de permisos por módulo vive en código (@dyn/authz).';
COMMENT ON TABLE "usuario" IS 'Cuenta de acceso de una persona. password_hash es nulo si se adopta Entra ID (entra_object_id).';
COMMENT ON TABLE "usuario_empleado" IS 'Datos de RRHH del usuario (1:1, opcionales). Contiene datos personales: acceso restringido.';
COMMENT ON TABLE "sesion" IS 'Refresh tokens rotativos; solo se guarda el SHA-256 del token.';
COMMENT ON COLUMN "usuario"."intentos_fallidos" IS 'Contador de logins fallidos consecutivos; se reinicia al entrar.';
COMMENT ON COLUMN "usuario"."bloqueado_hasta" IS 'Si es futuro, el login se rechaza aunque la contraseña sea correcta.';
