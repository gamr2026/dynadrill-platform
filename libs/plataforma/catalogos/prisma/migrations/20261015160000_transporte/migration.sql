-- Transporte para la guía de remisión: transportista, tipo de vehículo, vehículo y chofer (como en AS2).
CREATE TYPE "tipo_identificacion" AS ENUM ('ruc', 'cedula', 'pasaporte');

CREATE TABLE "transportista" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "codigo" TEXT,
    "nombre_fiscal" TEXT NOT NULL,
    "tipo_identificacion" "tipo_identificacion" NOT NULL,
    "identificacion" TEXT NOT NULL,
    "habilitado" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "transportista_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "transportista_codigo_key" ON "transportista"("codigo");
CREATE UNIQUE INDEX "transportista_identificacion_key" ON "transportista"("identificacion");

CREATE TABLE "tipo_vehiculo" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "nombre" TEXT NOT NULL,
    "habilitado" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "tipo_vehiculo_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "tipo_vehiculo_nombre_key" ON "tipo_vehiculo"("nombre");

CREATE TABLE "vehiculo" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "placa" TEXT NOT NULL,
    "marca" TEXT,
    "modelo" TEXT,
    "anio" INTEGER,
    "tipo_vehiculo_id" UUID,
    "transportista_id" UUID,
    "habilitado" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "vehiculo_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "vehiculo_placa_key" ON "vehiculo"("placa");
CREATE INDEX "vehiculo_transportista_id_idx" ON "vehiculo"("transportista_id");
ALTER TABLE "vehiculo" ADD CONSTRAINT "vehiculo_tipo_vehiculo_id_fkey" FOREIGN KEY ("tipo_vehiculo_id") REFERENCES "tipo_vehiculo"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vehiculo" ADD CONSTRAINT "vehiculo_transportista_id_fkey" FOREIGN KEY ("transportista_id") REFERENCES "transportista"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vehiculo" ADD CONSTRAINT "vehiculo_placa_check" CHECK ("placa" ~ '^[A-Z0-9](5, 8)$');
ALTER TABLE "vehiculo" ADD CONSTRAINT "vehiculo_anio_check" CHECK ("anio" IS NULL OR "anio" BETWEEN 1950 AND 2100);

CREATE TABLE "chofer" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "transportista_id" UUID NOT NULL,
    "licencia" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "habilitado" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "chofer_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "chofer_transportista_id_licencia_key" ON "chofer"("transportista_id", "licencia");
ALTER TABLE "chofer" ADD CONSTRAINT "chofer_transportista_id_fkey" FOREIGN KEY ("transportista_id") REFERENCES "transportista"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMENT ON TABLE "transportista" IS 'Quien traslada lo de la guía de remisión; distinto del chofer (como en AS2).';
