-- Pumping: pasos del servicio, ticket (uno por pedido) y su seguimiento.
CREATE TYPE "macro_estado" AS ENUM ('pendiente', 'en_proceso', 'esperando_aprobacion', 'aprobado', 'rechazado');
CREATE TYPE "origen_cambio" AS ENUM ('manual', 'sistema');

CREATE TABLE "paso" (
    "codigo" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "macro" "macro_estado" NOT NULL,
    "orden" INTEGER NOT NULL,
    "terminal" BOOLEAN NOT NULL DEFAULT false,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "paso_pkey" PRIMARY KEY ("codigo")
);

CREATE TABLE "paso_rol" (
    "paso_codigo" TEXT NOT NULL,
    "rol_codigo" TEXT NOT NULL,
    CONSTRAINT "paso_rol_pkey" PRIMARY KEY ("paso_codigo", "rol_codigo")
);
ALTER TABLE "paso_rol" ADD CONSTRAINT "paso_rol_paso_codigo_fkey" FOREIGN KEY ("paso_codigo") REFERENCES "paso"("codigo") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "transicion" (
    "id" UUID NOT NULL,
    "origen_codigo" TEXT NOT NULL,
    "destino_codigo" TEXT NOT NULL,
    "requiere_motivo" BOOLEAN NOT NULL DEFAULT false,
    "activa" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "transicion_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "transicion_origen_codigo_destino_codigo_key" ON "transicion"("origen_codigo", "destino_codigo");
ALTER TABLE "transicion" ADD CONSTRAINT "transicion_origen_codigo_fkey" FOREIGN KEY ("origen_codigo") REFERENCES "paso"("codigo") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "transicion" ADD CONSTRAINT "transicion_destino_codigo_fkey" FOREIGN KEY ("destino_codigo") REFERENCES "paso"("codigo") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "transicion" ADD CONSTRAINT "transicion_distinta_check" CHECK ("origen_codigo" <> "destino_codigo");

CREATE TABLE "contador" (
    "clave" TEXT NOT NULL,
    "valor" INTEGER NOT NULL,
    CONSTRAINT "contador_pkey" PRIMARY KEY ("clave")
);

CREATE TABLE "ticket" (
    "id" UUID NOT NULL,
    "codigo" TEXT NOT NULL,
    "pedido_id" UUID NOT NULL,
    "pedido_codigo" TEXT NOT NULL,
    "paso_codigo" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "tipo_ot" TEXT,
    "cliente_id" UUID,
    "cliente_nombre" TEXT,
    "cliente_ruc" TEXT,
    "campo_id" UUID,
    "campo_nombre" TEXT,
    "bloque_id" UUID,
    "bloque_nombre" TEXT,
    "pozo_id" UUID,
    "pozo_nombre" TEXT,
    "taladro_id" UUID,
    "taladro_nombre" TEXT,
    "rigless" BOOLEAN NOT NULL DEFAULT false,
    "numero_contrato" TEXT,
    "as2_numero" TEXT,
    "fecha_inicio_servicio" DATE,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ticket_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ticket_codigo_key" ON "ticket"("codigo");
CREATE UNIQUE INDEX "ticket_pedido_id_key" ON "ticket"("pedido_id");
CREATE INDEX "ticket_paso_codigo_idx" ON "ticket"("paso_codigo");
ALTER TABLE "ticket" ADD CONSTRAINT "ticket_paso_codigo_fkey" FOREIGN KEY ("paso_codigo") REFERENCES "paso"("codigo") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ticket" ADD CONSTRAINT "ticket_version_check" CHECK ("version" > 0);

CREATE TABLE "ticket_tipo_servicio" (
    "ticket_id" UUID NOT NULL,
    "tipo_codigo" TEXT NOT NULL,
    CONSTRAINT "ticket_tipo_servicio_pkey" PRIMARY KEY ("ticket_id", "tipo_codigo")
);
ALTER TABLE "ticket_tipo_servicio" ADD CONSTRAINT "ticket_tipo_servicio_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ticket_historial" (
    "id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "paso_anterior" TEXT,
    "paso_nuevo" TEXT NOT NULL,
    "motivo" TEXT,
    "actor_id" UUID,
    "actor_nombre" TEXT,
    "actor_rol" TEXT,
    "origen" "origen_cambio" NOT NULL DEFAULT 'manual',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ticket_historial_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ticket_historial_ticket_id_created_at_idx" ON "ticket_historial"("ticket_id", "created_at");
ALTER TABLE "ticket_historial" ADD CONSTRAINT "ticket_historial_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMENT ON TABLE "ticket" IS 'Ticket de servicio de Pumping: uno por pedido de la línea; copia los datos del pedido al abrirse.';
