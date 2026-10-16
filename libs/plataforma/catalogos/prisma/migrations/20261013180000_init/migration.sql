-- CreateTable
CREATE TABLE "cliente" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "legacy_id" INTEGER,
    "tipo_identificacion" TEXT NOT NULL,
    "identificacion" TEXT NOT NULL,
    "nombre_comercial" TEXT NOT NULL,
    "nombre_fiscal" TEXT,
    "activo" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "cliente_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "persona_contacto" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "legacy_id" INTEGER,
    "tipo" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "cedula" TEXT,
    "activo" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "persona_contacto_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bloque" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "legacy_id" INTEGER,
    "nombre" TEXT NOT NULL,
    "habilitado" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "bloque_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campo" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "legacy_id" INTEGER,
    "nombre" TEXT NOT NULL,
    "activo_operativo" TEXT,
    "zona" TEXT,
    "habilitado" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "campo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pozo" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "legacy_id" INTEGER,
    "codigo" TEXT NOT NULL,
    "nombre_completo" TEXT NOT NULL,
    "campo_id" UUID NOT NULL,
    "bloque_id" UUID NOT NULL,
    "habilitado" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "pozo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "taladro" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "legacy_id" INTEGER,
    "nombre" TEXT NOT NULL,
    "rig_contractual" TEXT,
    "habilitado" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "taladro_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "cliente_legacy_id_key" ON "cliente"("legacy_id");

-- CreateIndex
CREATE UNIQUE INDEX "cliente_identificacion_key" ON "cliente"("identificacion");

-- CreateIndex
CREATE UNIQUE INDEX "persona_contacto_legacy_id_key" ON "persona_contacto"("legacy_id");

-- CreateIndex
CREATE INDEX "persona_contacto_tipo_idx" ON "persona_contacto"("tipo");

-- CreateIndex
CREATE UNIQUE INDEX "persona_contacto_tipo_nombre_key" ON "persona_contacto"("tipo", "nombre");

-- CreateIndex
CREATE UNIQUE INDEX "bloque_legacy_id_key" ON "bloque"("legacy_id");

-- CreateIndex
CREATE UNIQUE INDEX "bloque_nombre_key" ON "bloque"("nombre");

-- CreateIndex
CREATE UNIQUE INDEX "campo_legacy_id_key" ON "campo"("legacy_id");

-- CreateIndex
CREATE UNIQUE INDEX "campo_nombre_key" ON "campo"("nombre");

-- CreateIndex
CREATE UNIQUE INDEX "pozo_legacy_id_key" ON "pozo"("legacy_id");

-- CreateIndex
CREATE UNIQUE INDEX "pozo_codigo_key" ON "pozo"("codigo");

-- CreateIndex
CREATE INDEX "pozo_campo_id_idx" ON "pozo"("campo_id");

-- CreateIndex
CREATE INDEX "pozo_bloque_id_idx" ON "pozo"("bloque_id");

-- CreateIndex
CREATE UNIQUE INDEX "taladro_legacy_id_key" ON "taladro"("legacy_id");

-- CreateIndex
CREATE UNIQUE INDEX "taladro_nombre_key" ON "taladro"("nombre");

-- AddForeignKey
ALTER TABLE "pozo" ADD CONSTRAINT "pozo_campo_id_fkey" FOREIGN KEY ("campo_id") REFERENCES "campo"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pozo" ADD CONSTRAINT "pozo_bloque_id_fkey" FOREIGN KEY ("bloque_id") REFERENCES "bloque"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Reglas y comentarios que Prisma no expresa ---------------------------------------------------------

ALTER TABLE "persona_contacto" ADD CONSTRAINT "persona_contacto_tipo_check"
  CHECK ("tipo" IN ('representante_campo', 'representante_quito', 'analista_facturacion', 'agente_comercial'));

COMMENT ON TABLE "cliente" IS 'Clientes (operadoras) con su identificación fiscal. Reemplaza el texto libre en el Pedido.';
COMMENT ON TABLE "persona_contacto" IS 'Company Man / Representante de campo, Representante Quito, Analista de Facturación y Agente Comercial usados en el Pedido.';
COMMENT ON TABLE "bloque" IS 'Bloques petroleros.';
COMMENT ON TABLE "campo" IS 'Campos petroleros; activo_operativo es el activo de Petroecuador (AIT, AM, AP...) y zona la región comercial.';
COMMENT ON TABLE "pozo" IS 'Pozos; cada uno pertenece a un campo y a un bloque.';
COMMENT ON TABLE "taladro" IS 'Taladros / rigs.';

COMMENT ON COLUMN "cliente"."legacy_id" IS 'TRANSICIÓN: id del cliente en el backend demo (se elimina al terminar la migración).';
COMMENT ON COLUMN "persona_contacto"."legacy_id" IS 'TRANSICIÓN: id en el backend demo (se elimina al terminar la migración).';
COMMENT ON COLUMN "bloque"."legacy_id" IS 'TRANSICIÓN: id en el backend demo (se elimina al terminar la migración).';
COMMENT ON COLUMN "campo"."legacy_id" IS 'TRANSICIÓN: id en el backend demo (se elimina al terminar la migración).';
COMMENT ON COLUMN "pozo"."legacy_id" IS 'TRANSICIÓN: id en el backend demo (se elimina al terminar la migración).';
COMMENT ON COLUMN "taladro"."legacy_id" IS 'TRANSICIÓN: id en el backend demo (se elimina al terminar la migración).';
