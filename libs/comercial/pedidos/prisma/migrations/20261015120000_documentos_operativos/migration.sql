-- Documentos operativos del pedido (Reporte Job y Reporte de Herramientas), normalizados: sin JSON.
CREATE TYPE "tipo_documento_operativo" AS ENUM ('reporte_job', 'reporte_herramientas');
CREATE TYPE "origen_operativo" AS ENUM ('fcr', 'pumping');
CREATE TYPE "estado_uso_herramienta" AS ENUM ('operacion', 'stand_by', 'daily_charge', 'venta');

CREATE TABLE "documento_operativo" (
    "id" UUID NOT NULL,
    "pedido_id" UUID NOT NULL,
    "tipo" "tipo_documento_operativo" NOT NULL,
    "origen" "origen_operativo" NOT NULL,
    "ticket_ref" TEXT,
    "fecha" DATE,
    "firmado_por" TEXT,
    "firmado_at" TIMESTAMPTZ(6),
    "supervisor_id" UUID,
    "supervisor_nombre" TEXT,
    "operador_id" UUID,
    "operador_nombre" TEXT,
    "recibido_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recibido_por" UUID NOT NULL,
    CONSTRAINT "documento_operativo_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "documento_operativo_pedido_id_tipo_idx" ON "documento_operativo"("pedido_id", "tipo");
ALTER TABLE "documento_operativo" ADD CONSTRAINT "documento_operativo_pedido_id_fkey"
  FOREIGN KEY ("pedido_id") REFERENCES "pedido"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Un Reporte Job por día y un Reporte de Herramientas por servicio (la fecha nula cuenta como un valor).
CREATE UNIQUE INDEX "documento_operativo_clave_idx"
  ON "documento_operativo"("pedido_id", "tipo", "origen", "fecha") NULLS NOT DISTINCT;
ALTER TABLE "documento_operativo" ADD CONSTRAINT "documento_operativo_fecha_check"
  CHECK (("tipo" = 'reporte_job') = ("fecha" IS NOT NULL));

CREATE TABLE "documento_operativo_actividad" (
    "id" UUID NOT NULL,
    "documento_id" UUID NOT NULL,
    "orden" INTEGER NOT NULL,
    "fecha" DATE NOT NULL,
    "hora_inicio" TEXT NOT NULL,
    "hora_fin" TEXT NOT NULL,
    "duracion_horas" DECIMAL(5,2) NOT NULL,
    "detalle" TEXT NOT NULL,
    "autor" TEXT,
    CONSTRAINT "documento_operativo_actividad_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "documento_operativo_actividad_documento_id_orden_key" ON "documento_operativo_actividad"("documento_id", "orden");
ALTER TABLE "documento_operativo_actividad" ADD CONSTRAINT "documento_operativo_actividad_documento_id_fkey"
  FOREIGN KEY ("documento_id") REFERENCES "documento_operativo"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "documento_operativo_actividad" ADD CONSTRAINT "documento_operativo_actividad_hora_check"
  CHECK ("hora_inicio" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND "hora_fin" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');
ALTER TABLE "documento_operativo_actividad" ADD CONSTRAINT "documento_operativo_actividad_duracion_check"
  CHECK ("duracion_horas" >= 0 AND "duracion_horas" <= 24);

CREATE TABLE "documento_operativo_herramienta" (
    "id" UUID NOT NULL,
    "documento_id" UUID NOT NULL,
    "orden" INTEGER NOT NULL,
    "nombre" TEXT NOT NULL,
    "serie" TEXT,
    "codigo" TEXT,
    CONSTRAINT "documento_operativo_herramienta_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "documento_operativo_herramienta_documento_id_orden_key" ON "documento_operativo_herramienta"("documento_id", "orden");
ALTER TABLE "documento_operativo_herramienta" ADD CONSTRAINT "documento_operativo_herramienta_documento_id_fkey"
  FOREIGN KEY ("documento_id") REFERENCES "documento_operativo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "documento_operativo_uso" (
    "id" UUID NOT NULL,
    "herramienta_id" UUID NOT NULL,
    "fecha" DATE NOT NULL,
    "estado" "estado_uso_herramienta" NOT NULL,
    CONSTRAINT "documento_operativo_uso_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "documento_operativo_uso_herramienta_id_fecha_key" ON "documento_operativo_uso"("herramienta_id", "fecha");
ALTER TABLE "documento_operativo_uso" ADD CONSTRAINT "documento_operativo_uso_herramienta_id_fkey"
  FOREIGN KEY ("herramienta_id") REFERENCES "documento_operativo_herramienta"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Un documento recibido se reemplaza por otro con la misma clave: la aplicación necesita DELETE en el documento y sus hijos.
GRANT DELETE ON "documento_operativo", "documento_operativo_actividad", "documento_operativo_herramienta", "documento_operativo_uso" TO app_comercial;

COMMENT ON TABLE "documento_operativo" IS 'Reporte Job (uno por día) y Reporte de Herramientas (uno por servicio) que llegan de Operaciones.';
