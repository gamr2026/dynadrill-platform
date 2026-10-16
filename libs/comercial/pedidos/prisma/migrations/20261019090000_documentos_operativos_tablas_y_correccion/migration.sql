-- C3 y C4 de plan-comercial-ajustes: tablas dentro de las actividades del Reporte Job y corrección por día de Facturación.
ALTER TABLE "documento_operativo"
  ADD COLUMN "corregido_at" TIMESTAMPTZ(6),
  ADD COLUMN "corregido_por" UUID,
  ADD CONSTRAINT "documento_operativo_corregido_por_fkey" FOREIGN KEY ("corregido_por") REFERENCES identidad.usuario ("id"),
  ADD CONSTRAINT "documento_operativo_corregido_check" CHECK (("corregido_at" IS NULL) = ("corregido_por" IS NULL));

CREATE TABLE "documento_operativo_actividad_tabla" (
    "id" UUID NOT NULL,
    "actividad_id" UUID NOT NULL,
    "orden" INTEGER NOT NULL,
    "titulo" TEXT,
    CONSTRAINT "documento_operativo_actividad_tabla_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "documento_operativo_actividad_tabla_actividad_id_orden_key" ON "documento_operativo_actividad_tabla"("actividad_id", "orden");

CREATE TABLE "documento_operativo_tabla_columna" (
    "id" UUID NOT NULL,
    "tabla_id" UUID NOT NULL,
    "orden" INTEGER NOT NULL,
    "encabezado" TEXT NOT NULL,
    CONSTRAINT "documento_operativo_tabla_columna_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "documento_operativo_tabla_columna_tabla_id_orden_key" ON "documento_operativo_tabla_columna"("tabla_id", "orden");

CREATE TABLE "documento_operativo_tabla_fila" (
    "id" UUID NOT NULL,
    "tabla_id" UUID NOT NULL,
    "orden" INTEGER NOT NULL,
    CONSTRAINT "documento_operativo_tabla_fila_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "documento_operativo_tabla_fila_tabla_id_orden_key" ON "documento_operativo_tabla_fila"("tabla_id", "orden");

CREATE TABLE "documento_operativo_tabla_celda" (
    "fila_id" UUID NOT NULL,
    "columna_id" UUID NOT NULL,
    "valor" TEXT NOT NULL,
    CONSTRAINT "documento_operativo_tabla_celda_pkey" PRIMARY KEY ("fila_id", "columna_id")
);

ALTER TABLE "documento_operativo_actividad_tabla" ADD CONSTRAINT "documento_operativo_actividad_tabla_actividad_id_fkey"
  FOREIGN KEY ("actividad_id") REFERENCES "documento_operativo_actividad"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "documento_operativo_tabla_columna" ADD CONSTRAINT "documento_operativo_tabla_columna_tabla_id_fkey"
  FOREIGN KEY ("tabla_id") REFERENCES "documento_operativo_actividad_tabla"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "documento_operativo_tabla_fila" ADD CONSTRAINT "documento_operativo_tabla_fila_tabla_id_fkey"
  FOREIGN KEY ("tabla_id") REFERENCES "documento_operativo_actividad_tabla"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "documento_operativo_tabla_celda" ADD CONSTRAINT "documento_operativo_tabla_celda_fila_id_fkey"
  FOREIGN KEY ("fila_id") REFERENCES "documento_operativo_tabla_fila"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "documento_operativo_tabla_celda" ADD CONSTRAINT "documento_operativo_tabla_celda_columna_id_fkey"
  FOREIGN KEY ("columna_id") REFERENCES "documento_operativo_tabla_columna"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Reemplazar un día implica borrar sus hijos: DELETE en las tablas nuevas (igual que en las de actividades).
GRANT DELETE ON "documento_operativo_actividad_tabla", "documento_operativo_tabla_columna",
  "documento_operativo_tabla_fila", "documento_operativo_tabla_celda" TO app_comercial;
