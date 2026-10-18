-- Reporte Diario de Actividades de Operaciones (DYN-SGI-RE-047, el «Reporte Job») de un ticket: un reporte por día, con sus actividades
-- y, dentro de cada actividad, tablas (encabezados, filas y celdas; sin JSON). El operador lo guarda como borrador, lo completa y se
-- puede reabrir; al completarlo se publica `operaciones.pumping.reporte_diario_completado` y Comercial lo recibe como documento
-- operativo (contrato 4.4). Si Facturación corrige un día, Comercial avisa y el ticket ya no puede editarlo ni reenviarlo.
CREATE TABLE "reporte_diario" (
    "id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "fecha" DATE NOT NULL,
    "representante_cliente" TEXT,
    "cargo_representante" TEXT,
    "tiempo_productivo" NUMERIC(5,2),
    "tiempo_no_productivo" NUMERIC(5,2),
    "observaciones" TEXT,
    "completado_at" TIMESTAMPTZ(6),
    "completado_por" UUID,
    "corregido_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID NOT NULL,
    CONSTRAINT "reporte_diario_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "reporte_diario_ticket_fkey" FOREIGN KEY ("ticket_id") REFERENCES "ticket"("id") ON DELETE CASCADE,
    CONSTRAINT "reporte_diario_completado_por_fkey" FOREIGN KEY ("completado_por") REFERENCES identidad.usuario("id"),
    CONSTRAINT "reporte_diario_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario("id"),
    CONSTRAINT "reporte_diario_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario("id"),
    -- completar deja quién y cuándo, siempre juntos
    CONSTRAINT "reporte_diario_completado_check" CHECK (("completado_at" IS NULL) = ("completado_por" IS NULL)),
    CONSTRAINT "reporte_diario_tiempos_check" CHECK (
        ("tiempo_productivo" IS NULL OR "tiempo_productivo" BETWEEN 0 AND 24)
        AND ("tiempo_no_productivo" IS NULL OR "tiempo_no_productivo" BETWEEN 0 AND 24)
    )
);
CREATE UNIQUE INDEX "reporte_diario_ticket_fecha_key" ON "reporte_diario"("ticket_id", "fecha");

CREATE TABLE "reporte_diario_actividad" (
    "id" UUID NOT NULL,
    "reporte_id" UUID NOT NULL,
    "orden" INTEGER NOT NULL,
    "hora_inicio" TIME(0) NOT NULL,
    "hora_fin" TIME(0) NOT NULL,
    "detalle" TEXT NOT NULL,
    "autor_id" UUID NOT NULL,
    CONSTRAINT "reporte_diario_actividad_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "reporte_diario_actividad_reporte_fkey" FOREIGN KEY ("reporte_id") REFERENCES "reporte_diario"("id") ON DELETE CASCADE,
    CONSTRAINT "reporte_diario_actividad_autor_fkey" FOREIGN KEY ("autor_id") REFERENCES identidad.usuario("id"),
    CONSTRAINT "reporte_diario_actividad_orden_check" CHECK ("orden" >= 0),
    CONSTRAINT "reporte_diario_actividad_horas_check" CHECK ("hora_inicio" <> "hora_fin"),
    CONSTRAINT "reporte_diario_actividad_detalle_check" CHECK (length(btrim("detalle")) > 0)
);
CREATE UNIQUE INDEX "reporte_diario_actividad_orden_key" ON "reporte_diario_actividad"("reporte_id", "orden");

CREATE TABLE "reporte_diario_tabla" (
    "id" UUID NOT NULL,
    "actividad_id" UUID NOT NULL,
    "orden" INTEGER NOT NULL,
    "titulo" TEXT,
    CONSTRAINT "reporte_diario_tabla_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "reporte_diario_tabla_actividad_fkey" FOREIGN KEY ("actividad_id") REFERENCES "reporte_diario_actividad"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "reporte_diario_tabla_orden_key" ON "reporte_diario_tabla"("actividad_id", "orden");

CREATE TABLE "reporte_diario_tabla_columna" (
    "id" UUID NOT NULL,
    "tabla_id" UUID NOT NULL,
    "orden" INTEGER NOT NULL,
    "encabezado" TEXT NOT NULL,
    CONSTRAINT "reporte_diario_tabla_columna_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "reporte_diario_tabla_columna_tabla_fkey" FOREIGN KEY ("tabla_id") REFERENCES "reporte_diario_tabla"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "reporte_diario_tabla_columna_orden_key" ON "reporte_diario_tabla_columna"("tabla_id", "orden");

CREATE TABLE "reporte_diario_tabla_fila" (
    "id" UUID NOT NULL,
    "tabla_id" UUID NOT NULL,
    "orden" INTEGER NOT NULL,
    CONSTRAINT "reporte_diario_tabla_fila_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "reporte_diario_tabla_fila_tabla_fkey" FOREIGN KEY ("tabla_id") REFERENCES "reporte_diario_tabla"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "reporte_diario_tabla_fila_orden_key" ON "reporte_diario_tabla_fila"("tabla_id", "orden");

CREATE TABLE "reporte_diario_tabla_celda" (
    "fila_id" UUID NOT NULL,
    "columna_id" UUID NOT NULL,
    "valor" TEXT NOT NULL,
    CONSTRAINT "reporte_diario_tabla_celda_pkey" PRIMARY KEY ("fila_id", "columna_id"),
    CONSTRAINT "reporte_diario_tabla_celda_fila_fkey" FOREIGN KEY ("fila_id") REFERENCES "reporte_diario_tabla_fila"("id") ON DELETE CASCADE,
    CONSTRAINT "reporte_diario_tabla_celda_columna_fkey" FOREIGN KEY ("columna_id") REFERENCES "reporte_diario_tabla_columna"("id") ON DELETE CASCADE
);
CREATE INDEX "reporte_diario_tabla_celda_columna_idx" ON "reporte_diario_tabla_celda"("columna_id");

-- Al guardar un día se reemplazan sus actividades (y por cascada sus tablas): la aplicación necesita borrar los hijos.
GRANT DELETE ON "reporte_diario_actividad", "reporte_diario_tabla", "reporte_diario_tabla_columna", "reporte_diario_tabla_fila", "reporte_diario_tabla_celda" TO app_operaciones;

COMMENT ON TABLE "reporte_diario" IS 'Reporte Diario de Actividades (DYN-SGI-RE-047) de un ticket: uno por día. Borrador hasta completarlo; se puede reabrir editándolo. El cliente, el pozo y el supervisor salen del ticket con JOIN (no se copian).';
COMMENT ON COLUMN "reporte_diario"."representante_cliente" IS 'Nombre del Company Man / representante del cliente (persona externa a Dynadrill: texto, no una cuenta).';
COMMENT ON COLUMN "reporte_diario"."corregido_at" IS 'Facturación corrigió este día en el pedido (evento de Comercial): el ticket ya no lo edita ni lo reenvía.';
COMMENT ON COLUMN "reporte_diario_actividad"."autor_id" IS 'Cuenta de quien escribió la actividad.';
