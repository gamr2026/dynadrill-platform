-- Mantenimiento, tramo M1: reportes de unidad recibidos, clasificación (descartar o generar una orden con sub-órdenes) y las bases
-- de la máquina de estados de la sub-orden. Ver documentacion/modulos/plan-mantenimiento.md.
--
-- Dependencias (mismo contenedor): `flota.unidad` (Flota, F1) y `pumping.reporte_unidad` (Pumping, traslado de salida). Este módulo
-- no escribe en ninguna de las dos; solo las referencia con FK. Los datos de la unidad y del reporte (novedades, combustible,
-- ticket) se obtienen con JOIN: aquí no se copian.

CREATE TYPE "origen_reporte" AS ENUM ('pumping', 'fcr', 'vehiculos', 'qhse');
CREATE TYPE "estado_final_unidad" AS ENUM ('disponible', 'con_restricciones');

-- ---------------------------------------------------------------------------------------------------------------
-- Catálogos del módulo
-- ---------------------------------------------------------------------------------------------------------------

-- Tipos de sub-orden (Plan de Mantenimiento 2026). `sufijo` forma el código de la sub-orden (R3201-M); `asignable` es falso en
-- el Operativo: no se asigna a un mecánico, se deriva a Pumping.
CREATE TABLE "tipo_suborden" (
    "codigo" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "sufijo" CHAR(1) NOT NULL,
    "asignable" BOOLEAN NOT NULL,
    "orden" INTEGER NOT NULL,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "tipo_suborden_pkey" PRIMARY KEY ("codigo")
);
CREATE UNIQUE INDEX "tipo_suborden_sufijo_key" ON "tipo_suborden" ("sufijo");

-- Estados de la sub-orden. `resuelta` = cuenta para aceptar la orden (cerrada o derivada a Pumping).
CREATE TABLE "estado_suborden" (
    "codigo" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "orden" INTEGER NOT NULL,
    "resuelta" BOOLEAN NOT NULL DEFAULT false,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "estado_suborden_pkey" PRIMARY KEY ("codigo")
);

-- Transiciones permitidas. `tipo_codigo` nulo = para cualquier tipo (la derivación solo es del Operativo).
CREATE TABLE "transicion_suborden" (
    "id" UUID NOT NULL,
    "origen_codigo" TEXT NOT NULL,
    "destino_codigo" TEXT NOT NULL,
    "tipo_codigo" TEXT,
    "requiere_nota" BOOLEAN NOT NULL DEFAULT false,
    "activa" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "transicion_suborden_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "transicion_suborden_origen_fkey" FOREIGN KEY ("origen_codigo") REFERENCES "estado_suborden" ("codigo"),
    CONSTRAINT "transicion_suborden_destino_fkey" FOREIGN KEY ("destino_codigo") REFERENCES "estado_suborden" ("codigo"),
    CONSTRAINT "transicion_suborden_tipo_fkey" FOREIGN KEY ("tipo_codigo") REFERENCES "tipo_suborden" ("codigo"),
    CONSTRAINT "transicion_suborden_distinta_check" CHECK ("origen_codigo" <> "destino_codigo")
);
CREATE UNIQUE INDEX "transicion_suborden_unica_key" ON "transicion_suborden" ("origen_codigo", "destino_codigo", "tipo_codigo") NULLS NOT DISTINCT;

-- Contadores propios (el número del reporte). Se incrementan con bloqueo de fila dentro de la transacción.
CREATE TABLE "contador" (
    "clave" TEXT NOT NULL,
    "valor" INTEGER NOT NULL,
    CONSTRAINT "contador_pkey" PRIMARY KEY ("clave"),
    CONSTRAINT "contador_valor_check" CHECK ("valor" >= 0)
);

-- ---------------------------------------------------------------------------------------------------------------
-- Reporte de unidad recibido (DYN-MNT-RE-012): lo registra el Operador en su área; Mantenimiento lo recibe y lo clasifica (MAN-001-A)
-- ---------------------------------------------------------------------------------------------------------------
-- Una columna de referencia por origen, con su FK real (nunca un id polimórfico sin FK):
--   · Pumping: FK a `pumping.reporte_unidad`; las novedades se leen de allí.
--   · QHSE (contenedor distinto, decisión D1): el id del caso de QHSE va sin FK, y la novedad es texto propio de este caso.
--   · FCR y Vehículos: sus columnas con FK se agregan cuando existan esas tablas (migración propia, `ALTER TABLE ... ADD COLUMN`).
CREATE TABLE "reporte_recibido" (
    "id" UUID NOT NULL,
    "codigo" TEXT NOT NULL,
    "origen" "origen_reporte" NOT NULL,
    "unidad_id" UUID NOT NULL,
    "pumping_reporte_unidad_id" UUID,
    "qhse_referencia_id" UUID,
    "novedad_qhse" TEXT,
    "recibido_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recibido_por" UUID,
    "descartado_at" TIMESTAMPTZ(6),
    "descartado_por" UUID,
    "motivo_descarte" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "reporte_recibido_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "reporte_recibido_unidad_fkey" FOREIGN KEY ("unidad_id") REFERENCES flota.unidad ("id"),
    CONSTRAINT "reporte_recibido_pumping_fkey" FOREIGN KEY ("pumping_reporte_unidad_id") REFERENCES pumping.reporte_unidad ("id"),
    CONSTRAINT "reporte_recibido_recibido_por_fkey" FOREIGN KEY ("recibido_por") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "reporte_recibido_descartado_por_fkey" FOREIGN KEY ("descartado_por") REFERENCES identidad.usuario ("id"),
    -- el origen decide qué referencia es obligatoria
    CONSTRAINT "reporte_recibido_origen_check" CHECK (
        ("origen" <> 'pumping' OR "pumping_reporte_unidad_id" IS NOT NULL)
        AND ("origen" <> 'qhse' OR ("qhse_referencia_id" IS NOT NULL AND length(btrim(coalesce("novedad_qhse", ''))) > 0))
        AND ("origen" = 'qhse' OR ("qhse_referencia_id" IS NULL AND "novedad_qhse" IS NULL))
        AND ("origen" = 'pumping' OR "pumping_reporte_unidad_id" IS NULL)
    ),
    -- descartar exige quién y un motivo (si Operaciones pregunta después por qué, queda la explicación)
    CONSTRAINT "reporte_recibido_descarte_check" CHECK (
        ("descartado_at" IS NULL) = ("descartado_por" IS NULL)
        AND ("descartado_at" IS NULL) = ("motivo_descarte" IS NULL)
        AND ("motivo_descarte" IS NULL OR length(btrim("motivo_descarte")) > 0)
    )
);
CREATE UNIQUE INDEX "reporte_recibido_codigo_key" ON "reporte_recibido" ("codigo");
-- un reporte de Pumping se recibe una sola vez (el evento es idempotente)
CREATE UNIQUE INDEX "reporte_recibido_pumping_key" ON "reporte_recibido" ("pumping_reporte_unidad_id") WHERE "pumping_reporte_unidad_id" IS NOT NULL;
CREATE UNIQUE INDEX "reporte_recibido_qhse_key" ON "reporte_recibido" ("qhse_referencia_id") WHERE "qhse_referencia_id" IS NOT NULL;
CREATE INDEX "reporte_recibido_unidad_idx" ON "reporte_recibido" ("unidad_id", "recibido_at" DESC);

-- ---------------------------------------------------------------------------------------------------------------
-- Orden de mantenimiento (una por reporte) y sus sub-órdenes. El código de la orden es el del reporte y el de la sub-orden es el de
-- la orden más el sufijo del tipo (R3201-M): se obtienen con JOIN, no se guardan. El estado de la orden se deriva de sus sub-órdenes.
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE "orden" (
    "id" UUID NOT NULL,
    "reporte_id" UUID NOT NULL,
    "retornada_at" TIMESTAMPTZ(6),
    "retornada_por" UUID,
    "estado_final" "estado_final_unidad",
    "observaciones_finales" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    CONSTRAINT "orden_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "orden_reporte_fkey" FOREIGN KEY ("reporte_id") REFERENCES "reporte_recibido" ("id"),
    CONSTRAINT "orden_retornada_por_fkey" FOREIGN KEY ("retornada_por") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "orden_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "orden_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id"),
    -- el retorno a operación deja quién, cuándo y en qué estado quedó la unidad
    CONSTRAINT "orden_retorno_check" CHECK (
        ("retornada_at" IS NULL) = ("retornada_por" IS NULL)
        AND ("retornada_at" IS NULL) = ("estado_final" IS NULL)
    )
);
CREATE UNIQUE INDEX "orden_reporte_id_key" ON "orden" ("reporte_id");

CREATE TABLE "suborden" (
    "id" UUID NOT NULL,
    "orden_id" UUID NOT NULL,
    "tipo_codigo" TEXT NOT NULL,
    "estado_codigo" TEXT NOT NULL DEFAULT 'pendiente',
    "asignada_a" UUID,
    "asignada_por" UUID,
    "nota_derivacion" TEXT,
    "diagnostico" TEXT,
    "actividades_correctivas" TEXT,
    "horas_trabajo" NUMERIC(8,2),
    "trabajos_adicionales" TEXT,
    "nota_correccion" TEXT,
    "ejecucion_iniciada_at" TIMESTAMPTZ(6),
    "ejecucion_terminada_at" TIMESTAMPTZ(6),
    "cierre_aprobado_at" TIMESTAMPTZ(6),
    "cierre_aprobado_por" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    CONSTRAINT "suborden_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "suborden_orden_fkey" FOREIGN KEY ("orden_id") REFERENCES "orden" ("id") ON DELETE CASCADE,
    CONSTRAINT "suborden_tipo_fkey" FOREIGN KEY ("tipo_codigo") REFERENCES "tipo_suborden" ("codigo"),
    CONSTRAINT "suborden_estado_fkey" FOREIGN KEY ("estado_codigo") REFERENCES "estado_suborden" ("codigo"),
    CONSTRAINT "suborden_asignada_a_fkey" FOREIGN KEY ("asignada_a") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "suborden_asignada_por_fkey" FOREIGN KEY ("asignada_por") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "suborden_cierre_aprobado_por_fkey" FOREIGN KEY ("cierre_aprobado_por") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "suborden_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "suborden_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "suborden_horas_check" CHECK ("horas_trabajo" IS NULL OR "horas_trabajo" >= 0),
    CONSTRAINT "suborden_asignacion_check" CHECK (("asignada_a" IS NULL) = ("asignada_por" IS NULL)),
    CONSTRAINT "suborden_cierre_check" CHECK (("cierre_aprobado_at" IS NULL) = ("cierre_aprobado_por" IS NULL))
);
-- una sub-orden por tipo en cada orden
CREATE UNIQUE INDEX "suborden_orden_tipo_key" ON "suborden" ("orden_id", "tipo_codigo");
CREATE INDEX "suborden_asignada_a_estado_idx" ON "suborden" ("asignada_a", "estado_codigo");
CREATE INDEX "suborden_estado_idx" ON "suborden" ("estado_codigo");

-- Al reclasificar una orden se quitan las sub-órdenes que ya no aplican (las cerradas se conservan).
GRANT DELETE ON "suborden" TO app_operaciones;

COMMENT ON TABLE "reporte_recibido" IS 'Reporte de unidad que Mantenimiento recibe y clasifica (MAN-001-A). El contenido del reporte vive en su origen (pumping.reporte_unidad).';
COMMENT ON TABLE "orden" IS 'Orden de mantenimiento correctivo: una por reporte. Su estado se deriva de las sub-órdenes; no se guarda.';
COMMENT ON TABLE "suborden" IS 'Trabajo de un tipo (mecánico, instrumental u operativo) dentro de una orden. Código = código de la orden + sufijo del tipo.';
