-- F5: control de retorno de las herramientas (devueltas o faltantes con su causa), reporte de unidad de llegada y cierre.

CREATE TYPE "causa_faltante" AS ENUM ('venta_complementaria', 'perdida', 'dano', 'otro');

-- La causa del faltante es un conjunto conocido (enum); el texto libre queda como detalle
ALTER TABLE "ticket_herramienta" ADD COLUMN "faltante_causa" "causa_faltante";
ALTER TABLE "ticket_herramienta" ADD CONSTRAINT "ticket_herramienta_faltante_causa_check" CHECK (("faltante_at" IS NULL) = ("faltante_causa" IS NULL));
COMMENT ON COLUMN "ticket_herramienta"."faltante_causa" IS 'Por qué falta la herramienta al retorno: venta de herramienta complementaria al cliente, pérdida, daño u otro (el detalle va en `faltante_motivo`).';
COMMENT ON COLUMN "ticket_herramienta"."faltante_motivo" IS 'Detalle de lo ocurrido con la herramienta faltante (obligatorio).';

-- ---------------------------------------------------------------------------------------------------------------
-- Reporte de unidad de llegada (uno por ticket y unidad, firmado por el operador de esa unidad; inmutable)
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE "reporte_unidad_llegada" (
    "id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "vehiculo_id" UUID NOT NULL,
    "llegada_fecha" DATE NOT NULL,
    "combustible" NUMERIC(8,2) NOT NULL,
    "novedades_mecanica" TEXT,
    "novedades_instrumentacion" TEXT,
    "novedades_operaciones" TEXT,
    "unidad_lista" BOOLEAN NOT NULL,
    "operacion_interrumpida" BOOLEAN NOT NULL,
    "detalle_interrupcion" TEXT,
    "firmada_por" UUID NOT NULL,
    "firmada_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "reporte_unidad_llegada_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "reporte_unidad_llegada_ticket_fkey" FOREIGN KEY ("ticket_id") REFERENCES "ticket" ("id") ON DELETE CASCADE,
    CONSTRAINT "reporte_unidad_llegada_unidad_fkey" FOREIGN KEY ("ticket_id", "vehiculo_id") REFERENCES "ticket_unidad" ("ticket_id", "vehiculo_id"),
    CONSTRAINT "reporte_unidad_llegada_firmada_por_fkey" FOREIGN KEY ("firmada_por") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "reporte_unidad_llegada_combustible_check" CHECK ("combustible" >= 0),
    -- una operación interrumpida se explica; una que no se interrumpió no lleva detalle
    CONSTRAINT "reporte_unidad_llegada_interrupcion_check" CHECK (
      ("operacion_interrumpida" AND length(btrim(coalesce("detalle_interrupcion", ''))) > 0)
      OR (NOT "operacion_interrumpida" AND "detalle_interrupcion" IS NULL)
    ),
    CONSTRAINT "reporte_unidad_llegada_texto_check" CHECK (
      length(btrim(coalesce("novedades_mecanica", 'x'))) > 0 AND length(btrim(coalesce("novedades_instrumentacion", 'x'))) > 0
      AND length(btrim(coalesce("novedades_operaciones", 'x'))) > 0
    )
);
CREATE UNIQUE INDEX "reporte_unidad_llegada_unidad_key" ON "reporte_unidad_llegada" ("ticket_id", "vehiculo_id");
CREATE INDEX "reporte_unidad_llegada_vehiculo_idx" ON "reporte_unidad_llegada" ("vehiculo_id");
-- un reporte firmado es un documento: no se edita ni se borra
REVOKE UPDATE, DELETE ON "reporte_unidad_llegada" FROM app_operaciones;
COMMENT ON TABLE "reporte_unidad_llegada" IS 'Reporte de unidad de llegada (DYN-MNT-RE-012, parte de llegada): lo firma el operador asignado a la unidad en el control de retorno. Mantenimiento lo recibe por el evento operaciones.fcr.reporte_unidad_llegada y lee las novedades de aquí (FK real, mismo contenedor). Inmutable. FCR no registra el reporte de salida (el servicio no tiene traslados: consulta F-26).';
