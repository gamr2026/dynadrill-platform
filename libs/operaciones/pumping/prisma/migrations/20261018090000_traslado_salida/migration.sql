-- Traslado de salida (O4): asignación emparejada, requisitos por paso, términos y condiciones, checklist de ingreso a locación y
-- reporte de unidad. Ver documentacion/pumping/PLAN-TRASLADO-SALIDA.md.

-- El paso `mantenimiento` sale del flujo (spec "Mantenimiento fuera del flujo del ticket de Pumping"): queda inactivo.
UPDATE "paso" SET "activo" = false WHERE "codigo" = 'mantenimiento';

CREATE TYPE "estado_requisito" AS ENUM ('pendiente', 'cumplido');
CREATE TYPE "origen_cumplimiento" AS ENUM ('sistema', 'evento', 'manual_temporal');
CREATE TYPE "ambito_requisito" AS ENUM ('ticket', 'unidad', 'operador');
CREATE TYPE "modulo_dueno" AS ENUM ('pumping', 'qhse', 'mantenimiento');
CREATE TYPE "gas_ingreso" AS ENUM ('h2s', 'lel', 'o2', 'co');
CREATE TYPE "seccion_inspeccion" AS ENUM ('chasis', 'motor', 'equipo', 'instrumentacion');
CREATE TYPE "resultado_inspeccion" AS ENUM ('conforme', 'no_conforme');
CREATE TYPE "posicion_llanta" AS ENUM ('delantera_izquierda', 'delantera_derecha', 'trasera_izquierda', 'trasera_derecha');
CREATE TYPE "punto_hubodometro" AS ENUM ('origen', 'destino');

-- ---------------------------------------------------------------------------------------------------------------
-- Asignación emparejada: cada operador lleva su unidad (como en la demo)
-- ---------------------------------------------------------------------------------------------------------------
ALTER TABLE "ticket_persona" ADD COLUMN "vehiculo_id" UUID;
ALTER TABLE "ticket_persona"
  ADD CONSTRAINT "ticket_persona_unidad_fkey" FOREIGN KEY ("ticket_id", "vehiculo_id") REFERENCES "ticket_unidad" ("ticket_id", "vehiculo_id");
CREATE INDEX "ticket_persona_vehiculo_id_idx" ON "ticket_persona" ("vehiculo_id");

-- ---------------------------------------------------------------------------------------------------------------
-- Requisitos por paso
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE "requisito" (
    "codigo" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "descripcion" TEXT,
    "ambito" "ambito_requisito" NOT NULL,
    "modulo" "modulo_dueno" NOT NULL,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "requisito_pkey" PRIMARY KEY ("codigo")
);

CREATE TABLE "paso_requisito" (
    "paso_codigo" TEXT NOT NULL,
    "requisito_codigo" TEXT NOT NULL,
    CONSTRAINT "paso_requisito_pkey" PRIMARY KEY ("paso_codigo", "requisito_codigo"),
    CONSTRAINT "paso_requisito_paso_fkey" FOREIGN KEY ("paso_codigo") REFERENCES "paso" ("codigo"),
    CONSTRAINT "paso_requisito_requisito_fkey" FOREIGN KEY ("requisito_codigo") REFERENCES "requisito" ("codigo")
);

CREATE TABLE "ticket_requisito" (
    "id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "requisito_codigo" TEXT NOT NULL,
    "vehiculo_id" UUID,
    "usuario_id" UUID,
    "estado" "estado_requisito" NOT NULL DEFAULT 'pendiente',
    "cumplido_at" TIMESTAMPTZ(6),
    "cumplido_por" UUID,
    "origen" "origen_cumplimiento",
    "motivo" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ticket_requisito_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ticket_requisito_ticket_fkey" FOREIGN KEY ("ticket_id") REFERENCES "ticket" ("id") ON DELETE CASCADE,
    CONSTRAINT "ticket_requisito_requisito_fkey" FOREIGN KEY ("requisito_codigo") REFERENCES "requisito" ("codigo"),
    -- un requisito es del ticket, de una unidad o de un operador asignados (nunca de los dos a la vez)
    CONSTRAINT "ticket_requisito_unidad_fkey" FOREIGN KEY ("ticket_id", "vehiculo_id") REFERENCES "ticket_unidad" ("ticket_id", "vehiculo_id"),
    CONSTRAINT "ticket_requisito_persona_fkey" FOREIGN KEY ("ticket_id", "usuario_id") REFERENCES "ticket_persona" ("ticket_id", "usuario_id"),
    CONSTRAINT "ticket_requisito_vehiculo_fkey" FOREIGN KEY ("vehiculo_id") REFERENCES catalogos.vehiculo ("id"),
    CONSTRAINT "ticket_requisito_usuario_fkey" FOREIGN KEY ("usuario_id") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "ticket_requisito_cumplido_por_fkey" FOREIGN KEY ("cumplido_por") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "ticket_requisito_ambito_check" CHECK ("vehiculo_id" IS NULL OR "usuario_id" IS NULL),
    CONSTRAINT "ticket_requisito_cumplido_check" CHECK (("estado" = 'cumplido') = ("cumplido_at" IS NOT NULL)),
    CONSTRAINT "ticket_requisito_manual_check" CHECK ("origen" IS DISTINCT FROM 'manual_temporal' OR length(btrim(coalesce("motivo", ''))) > 0)
);
-- un solo registro por requisito, ticket y unidad u operador (los nulos cuentan como iguales)
CREATE UNIQUE INDEX "ticket_requisito_unico_key" ON "ticket_requisito" ("ticket_id", "requisito_codigo", "vehiculo_id", "usuario_id") NULLS NOT DISTINCT;
CREATE INDEX "ticket_requisito_ticket_estado_idx" ON "ticket_requisito" ("ticket_id", "estado");

-- ---------------------------------------------------------------------------------------------------------------
-- Términos y condiciones de uso de equipos (versionados e inmutables)
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE "terminos_version" (
    "codigo" TEXT NOT NULL,
    "titulo" TEXT NOT NULL,
    "texto" TEXT NOT NULL,
    "texto_hash" TEXT NOT NULL,
    "vigente" BOOLEAN NOT NULL DEFAULT false,
    "publicado_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "terminos_version_pkey" PRIMARY KEY ("codigo"),
    CONSTRAINT "terminos_version_hash_check" CHECK ("texto_hash" ~ '^[0-9a-f]{64}$')
);
-- una sola versión vigente a la vez
CREATE UNIQUE INDEX "terminos_version_vigente_key" ON "terminos_version" ("vigente") WHERE "vigente";

CREATE TABLE "aceptacion_terminos" (
    "id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "usuario_id" UUID NOT NULL,
    "version_codigo" TEXT NOT NULL,
    "aceptado_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "aceptacion_terminos_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "aceptacion_terminos_persona_fkey" FOREIGN KEY ("ticket_id", "usuario_id") REFERENCES "ticket_persona" ("ticket_id", "usuario_id") ON DELETE CASCADE,
    CONSTRAINT "aceptacion_terminos_ticket_fkey" FOREIGN KEY ("ticket_id") REFERENCES "ticket" ("id") ON DELETE CASCADE,
    CONSTRAINT "aceptacion_terminos_usuario_fkey" FOREIGN KEY ("usuario_id") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "aceptacion_terminos_version_fkey" FOREIGN KEY ("version_codigo") REFERENCES "terminos_version" ("codigo")
);
CREATE UNIQUE INDEX "aceptacion_terminos_unica_key" ON "aceptacion_terminos" ("ticket_id", "usuario_id", "version_codigo");
CREATE INDEX "aceptacion_terminos_usuario_idx" ON "aceptacion_terminos" ("usuario_id");
-- la aceptación es una constancia: solo se crea y se lee
REVOKE UPDATE ON "aceptacion_terminos", "terminos_version" FROM app_operaciones;

-- ---------------------------------------------------------------------------------------------------------------
-- Checklist de ingreso a locación + verificaciones de seguridad
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE "gas_limite" (
    "gas" "gas_ingreso" NOT NULL,
    "nombre" TEXT NOT NULL,
    "unidad" TEXT NOT NULL,
    "minimo" DECIMAL(8,2),
    "maximo" DECIMAL(8,2) NOT NULL,
    CONSTRAINT "gas_limite_pkey" PRIMARY KEY ("gas")
);

CREATE TABLE "loto_item" (
    "id" UUID NOT NULL,
    "orden" INTEGER NOT NULL,
    "etiqueta" TEXT NOT NULL,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "loto_item_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "loto_item_orden_key" ON "loto_item" ("orden");
CREATE UNIQUE INDEX "loto_item_etiqueta_key" ON "loto_item" ("etiqueta");

CREATE TABLE "ticket_ingreso" (
    "ticket_id" UUID NOT NULL,
    "toolbox_talk_realizado" BOOLEAN NOT NULL DEFAULT false,
    "walkaround_completado" BOOLEAN NOT NULL DEFAULT false,
    "linea_base_ambiental_documentada" BOOLEAN NOT NULL DEFAULT false,
    "rutas_emergencia_verificadas" BOOLEAN NOT NULL DEFAULT false,
    "simops_confirmado" BOOLEAN NOT NULL DEFAULT false,
    "loto_notificado_cliente_at" TIMESTAMPTZ(6),
    "confirmado_por" UUID,
    "confirmado_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ticket_ingreso_pkey" PRIMARY KEY ("ticket_id"),
    CONSTRAINT "ticket_ingreso_ticket_fkey" FOREIGN KEY ("ticket_id") REFERENCES "ticket" ("id") ON DELETE CASCADE,
    CONSTRAINT "ticket_ingreso_confirmado_por_fkey" FOREIGN KEY ("confirmado_por") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "ticket_ingreso_confirmado_check" CHECK (("confirmado_at" IS NULL) = ("confirmado_por" IS NULL))
);

CREATE TABLE "ticket_ingreso_gas" (
    "id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "gas" "gas_ingreso" NOT NULL,
    "lectura" DECIMAL(8,2) NOT NULL,
    "seguro" BOOLEAN NOT NULL,
    "medido_por" UUID NOT NULL,
    "medido_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ticket_ingreso_gas_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ticket_ingreso_gas_ticket_fkey" FOREIGN KEY ("ticket_id") REFERENCES "ticket_ingreso" ("ticket_id") ON DELETE CASCADE,
    CONSTRAINT "ticket_ingreso_gas_gas_fkey" FOREIGN KEY ("gas") REFERENCES "gas_limite" ("gas"),
    CONSTRAINT "ticket_ingreso_gas_medido_por_fkey" FOREIGN KEY ("medido_por") REFERENCES identidad.usuario ("id")
);
CREATE INDEX "ticket_ingreso_gas_ticket_gas_idx" ON "ticket_ingreso_gas" ("ticket_id", "gas", "medido_at");

CREATE TABLE "ticket_ingreso_loto" (
    "ticket_id" UUID NOT NULL,
    "loto_item_id" UUID NOT NULL,
    "marcado" BOOLEAN NOT NULL DEFAULT false,
    "marcado_por" UUID,
    "marcado_at" TIMESTAMPTZ(6),
    CONSTRAINT "ticket_ingreso_loto_pkey" PRIMARY KEY ("ticket_id", "loto_item_id"),
    CONSTRAINT "ticket_ingreso_loto_ticket_fkey" FOREIGN KEY ("ticket_id") REFERENCES "ticket_ingreso" ("ticket_id") ON DELETE CASCADE,
    CONSTRAINT "ticket_ingreso_loto_item_fkey" FOREIGN KEY ("loto_item_id") REFERENCES "loto_item" ("id"),
    CONSTRAINT "ticket_ingreso_loto_marcado_por_fkey" FOREIGN KEY ("marcado_por") REFERENCES identidad.usuario ("id")
);

-- ---------------------------------------------------------------------------------------------------------------
-- Reporte de unidad (DYN-MNT-RE-012): una por ticket y unidad; la salida se llena en Traslado de salida y la llegada en
-- Traslado de llegada
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE "inspeccion_item" (
    "id" UUID NOT NULL,
    "seccion" "seccion_inspeccion" NOT NULL,
    "orden" INTEGER NOT NULL,
    "etiqueta" TEXT NOT NULL,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "inspeccion_item_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "inspeccion_item_seccion_orden_key" ON "inspeccion_item" ("seccion", "orden");
CREATE UNIQUE INDEX "inspeccion_item_seccion_etiqueta_key" ON "inspeccion_item" ("seccion", "etiqueta");

CREATE TABLE "reporte_unidad" (
    "id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "vehiculo_id" UUID NOT NULL,
    "origen" TEXT,
    "destino" TEXT,
    "salida_fecha" DATE,
    "salida_combustible" DECIMAL(8,2),
    "salida_firmada_por" UUID,
    "salida_firmada_at" TIMESTAMPTZ(6),
    "llegada_fecha" DATE,
    "llegada_combustible" DECIMAL(8,2),
    "novedades_mecanica" TEXT,
    "novedades_instrumentacion" TEXT,
    "novedades_operaciones" TEXT,
    "unidad_lista" BOOLEAN,
    "operacion_interrumpida" BOOLEAN,
    "detalle_interrupcion" TEXT,
    "llegada_firmada_por" UUID,
    "llegada_firmada_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "reporte_unidad_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "reporte_unidad_unidad_fkey" FOREIGN KEY ("ticket_id", "vehiculo_id") REFERENCES "ticket_unidad" ("ticket_id", "vehiculo_id") ON DELETE CASCADE,
    CONSTRAINT "reporte_unidad_ticket_fkey" FOREIGN KEY ("ticket_id") REFERENCES "ticket" ("id") ON DELETE CASCADE,
    CONSTRAINT "reporte_unidad_vehiculo_fkey" FOREIGN KEY ("vehiculo_id") REFERENCES catalogos.vehiculo ("id"),
    CONSTRAINT "reporte_unidad_salida_firmada_por_fkey" FOREIGN KEY ("salida_firmada_por") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "reporte_unidad_llegada_firmada_por_fkey" FOREIGN KEY ("llegada_firmada_por") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "reporte_unidad_salida_firma_check" CHECK (("salida_firmada_at" IS NULL) = ("salida_firmada_por" IS NULL)),
    CONSTRAINT "reporte_unidad_llegada_firma_check" CHECK (("llegada_firmada_at" IS NULL) = ("llegada_firmada_por" IS NULL))
);
CREATE UNIQUE INDEX "reporte_unidad_ticket_vehiculo_key" ON "reporte_unidad" ("ticket_id", "vehiculo_id");

CREATE TABLE "reporte_unidad_hubodometro" (
    "reporte_id" UUID NOT NULL,
    "eje" TEXT NOT NULL,
    "punto" "punto_hubodometro" NOT NULL,
    "salida" DECIMAL(12,2),
    "llegada" DECIMAL(12,2),
    CONSTRAINT "reporte_unidad_hubodometro_pkey" PRIMARY KEY ("reporte_id", "eje", "punto"),
    CONSTRAINT "reporte_unidad_hubodometro_reporte_fkey" FOREIGN KEY ("reporte_id") REFERENCES "reporte_unidad" ("id") ON DELETE CASCADE,
    CONSTRAINT "reporte_unidad_hubodometro_eje_check" CHECK ("eje" ~ '^[A-Z]$')
);

CREATE TABLE "reporte_unidad_llanta" (
    "reporte_id" UUID NOT NULL,
    "posicion" "posicion_llanta" NOT NULL,
    "salida" TEXT,
    "llegada" TEXT,
    CONSTRAINT "reporte_unidad_llanta_pkey" PRIMARY KEY ("reporte_id", "posicion"),
    CONSTRAINT "reporte_unidad_llanta_reporte_fkey" FOREIGN KEY ("reporte_id") REFERENCES "reporte_unidad" ("id") ON DELETE CASCADE
);

CREATE TABLE "reporte_unidad_inspeccion" (
    "reporte_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "salida" "resultado_inspeccion",
    "llegada" "resultado_inspeccion",
    CONSTRAINT "reporte_unidad_inspeccion_pkey" PRIMARY KEY ("reporte_id", "item_id"),
    CONSTRAINT "reporte_unidad_inspeccion_reporte_fkey" FOREIGN KEY ("reporte_id") REFERENCES "reporte_unidad" ("id") ON DELETE CASCADE,
    CONSTRAINT "reporte_unidad_inspeccion_item_fkey" FOREIGN KEY ("item_id") REFERENCES "inspeccion_item" ("id")
);

-- al guardar de nuevo la salida se reemplazan las lecturas y llantas
GRANT DELETE ON "reporte_unidad_hubodometro", "reporte_unidad_llanta", "reporte_unidad_inspeccion" TO app_operaciones;
