-- QHSE, tramo Q1: entrega de EPI (DYN-SGI-RE-032) y la referencia local de los tickets que la originan.
-- Las FK a `identidad` son reales (mismo servidor); el ticket vive en otro contenedor (operaciones), por eso solo se guarda su
-- referencia (id y número) en `ticket_ref`, que se llena por evento (decisión D1 de documentacion/modulos/03-DECISIONES-PENDIENTES.md).

-- Lectura mínima de las tablas maestras (nunca la clave ni los datos de acceso).
GRANT USAGE ON SCHEMA identidad TO app_qhse;
GRANT SELECT (id, nombre, email, activo, rol_id) ON identidad.usuario TO app_qhse;
GRANT SELECT (id, codigo, nombre) ON identidad.rol TO app_qhse;
GRANT SELECT (usuario_id, cedula, cargo) ON identidad.usuario_perfil TO app_qhse;

CREATE TYPE "estado_epi" AS ENUM ('solicitado', 'aprobado', 'despachado', 'rechazado');

-- ---------------------------------------------------------------------------------------------------------------
-- Tickets que QHSE conoce (los que llegan por evento desde Pumping; luego FCR)
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE "ticket_ref" (
    "ticket_id" UUID NOT NULL,
    "ticket_numero" INTEGER,
    "pedido_id" UUID NOT NULL,
    "pedido_codigo" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ticket_ref_pkey" PRIMARY KEY ("ticket_id")
);
CREATE INDEX "ticket_ref_pedido_id_idx" ON "ticket_ref" ("pedido_id");

-- ---------------------------------------------------------------------------------------------------------------
-- Catálogo de elementos de protección individual y ropa de trabajo
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE "epi_elemento" (
    "id" UUID NOT NULL,
    "nombre" TEXT NOT NULL,
    "requiere_talla" BOOLEAN NOT NULL DEFAULT false,
    "orden" INTEGER NOT NULL,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "epi_elemento_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "epi_elemento_nombre_check" CHECK (length(btrim("nombre")) > 0)
);
CREATE UNIQUE INDEX "epi_elemento_nombre_key" ON "epi_elemento" (lower("nombre"));
CREATE UNIQUE INDEX "epi_elemento_orden_key" ON "epi_elemento" ("orden");

-- ---------------------------------------------------------------------------------------------------------------
-- Entrega de EPI: una cabecera por trabajador (y por ticket, si la origina un servicio)
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE "epi_entrega" (
    "id" UUID NOT NULL,
    "numero" INTEGER GENERATED ALWAYS AS IDENTITY,
    "trabajador_id" UUID NOT NULL,
    "ticket_id" UUID,
    "lugar" TEXT,
    "estado" "estado_epi" NOT NULL DEFAULT 'solicitado',
    "firma_trabajador_por" UUID,
    "firma_trabajador_at" TIMESTAMPTZ(6),
    "firma_th_por" UUID,
    "firma_th_at" TIMESTAMPTZ(6),
    "aprobado_por" UUID,
    "aprobado_at" TIMESTAMPTZ(6),
    "rechazado_por" UUID,
    "rechazado_at" TIMESTAMPTZ(6),
    "motivo_rechazo" TEXT,
    "despachado_por" UUID,
    "despachado_at" TIMESTAMPTZ(6),
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "epi_entrega_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "epi_entrega_trabajador_fkey" FOREIGN KEY ("trabajador_id") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "epi_entrega_ticket_fkey" FOREIGN KEY ("ticket_id") REFERENCES "ticket_ref" ("ticket_id"),
    CONSTRAINT "epi_entrega_firma_trabajador_por_fkey" FOREIGN KEY ("firma_trabajador_por") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "epi_entrega_firma_th_por_fkey" FOREIGN KEY ("firma_th_por") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "epi_entrega_aprobado_por_fkey" FOREIGN KEY ("aprobado_por") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "epi_entrega_rechazado_por_fkey" FOREIGN KEY ("rechazado_por") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "epi_entrega_despachado_por_fkey" FOREIGN KEY ("despachado_por") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "epi_entrega_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "epi_entrega_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "epi_entrega_firma_trabajador_check" CHECK (("firma_trabajador_at" IS NULL) = ("firma_trabajador_por" IS NULL)),
    CONSTRAINT "epi_entrega_firma_th_check" CHECK (("firma_th_at" IS NULL) = ("firma_th_por" IS NULL)),
    CONSTRAINT "epi_entrega_aprobado_check" CHECK (("aprobado_at" IS NULL) = ("aprobado_por" IS NULL)),
    CONSTRAINT "epi_entrega_rechazado_check" CHECK (("rechazado_at" IS NULL) = ("rechazado_por" IS NULL)),
    CONSTRAINT "epi_entrega_despachado_check" CHECK (("despachado_at" IS NULL) = ("despachado_por" IS NULL)),
    -- el estado dice qué fechas existen: solo se despacha lo aprobado y solo se rechaza con motivo
    CONSTRAINT "epi_entrega_estado_check" CHECK (
        ("estado" = 'solicitado' AND "aprobado_at" IS NULL AND "rechazado_at" IS NULL AND "despachado_at" IS NULL)
        OR ("estado" = 'aprobado' AND "aprobado_at" IS NOT NULL AND "rechazado_at" IS NULL AND "despachado_at" IS NULL)
        OR ("estado" = 'despachado' AND "aprobado_at" IS NOT NULL AND "rechazado_at" IS NULL AND "despachado_at" IS NOT NULL)
        OR ("estado" = 'rechazado' AND "rechazado_at" IS NOT NULL AND "despachado_at" IS NULL
            AND length(btrim(coalesce("motivo_rechazo", ''))) > 0)
    )
);
CREATE UNIQUE INDEX "epi_entrega_numero_key" ON "epi_entrega" ("numero");
CREATE INDEX "epi_entrega_trabajador_id_idx" ON "epi_entrega" ("trabajador_id");
CREATE INDEX "epi_entrega_estado_idx" ON "epi_entrega" ("estado");
-- un trabajador tiene una sola entrega vigente por ticket (una rechazada no cuenta: se puede volver a solicitar)
CREATE UNIQUE INDEX "epi_entrega_ticket_trabajador_key" ON "epi_entrega" ("ticket_id", "trabajador_id")
    WHERE "ticket_id" IS NOT NULL AND "estado" <> 'rechazado';

CREATE TABLE "epi_entrega_item" (
    "id" UUID NOT NULL,
    "entrega_id" UUID NOT NULL,
    "elemento_id" UUID NOT NULL,
    "cantidad" INTEGER NOT NULL,
    "talla" TEXT,
    "codigo" TEXT,
    "recibio_capacitacion" BOOLEAN NOT NULL DEFAULT false,
    "observaciones" TEXT,
    "entregado_el" DATE NOT NULL DEFAULT CURRENT_DATE,
    CONSTRAINT "epi_entrega_item_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "epi_entrega_item_entrega_fkey" FOREIGN KEY ("entrega_id") REFERENCES "epi_entrega" ("id") ON DELETE CASCADE,
    CONSTRAINT "epi_entrega_item_elemento_fkey" FOREIGN KEY ("elemento_id") REFERENCES "epi_elemento" ("id"),
    CONSTRAINT "epi_entrega_item_cantidad_check" CHECK ("cantidad" > 0)
);
CREATE INDEX "epi_entrega_item_entrega_id_idx" ON "epi_entrega_item" ("entrega_id");
-- los renglones se reemplazan mientras la entrega no está despachada
GRANT DELETE ON "epi_entrega_item" TO app_qhse;

-- Rastro de cada cambio de estado (también las reversiones, que borran las fechas de la cabecera)
CREATE TABLE "epi_entrega_historial" (
    "id" UUID NOT NULL,
    "entrega_id" UUID NOT NULL,
    "estado_anterior" "estado_epi",
    "estado_nuevo" "estado_epi" NOT NULL,
    "motivo" TEXT,
    "actor_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "epi_entrega_historial_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "epi_entrega_historial_entrega_fkey" FOREIGN KEY ("entrega_id") REFERENCES "epi_entrega" ("id") ON DELETE CASCADE,
    CONSTRAINT "epi_entrega_historial_actor_fkey" FOREIGN KEY ("actor_id") REFERENCES identidad.usuario ("id")
);
CREATE INDEX "epi_entrega_historial_entrega_idx" ON "epi_entrega_historial" ("entrega_id", "created_at");
-- es un rastro: solo se agrega y se lee
REVOKE UPDATE ON "epi_entrega_historial" FROM app_qhse;

COMMENT ON TABLE "ticket_ref" IS 'Tickets (de otro contenedor) que originan casos de QHSE; se llena por evento, sin FK al schema ajeno.';
COMMENT ON TABLE "epi_entrega" IS 'Registro de entrega de EPI y ropa de trabajo (DYN-SGI-RE-032): solicitado, aprobado, despachado o rechazado.';
COMMENT ON COLUMN "epi_entrega"."firma_trabajador_por" IS 'Cuenta que registró la declaración del trabajador (firma "de una línea": cuenta y hora del servidor).';
