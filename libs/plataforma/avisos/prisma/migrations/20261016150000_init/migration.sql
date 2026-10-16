-- Avisos: campanita y correo con la misma regla (evento + rol -> plantilla).
CREATE TYPE "tono_aviso" AS ENUM ('info', 'warning', 'error');
CREATE TYPE "estado_correo" AS ENUM ('enviado', 'fallido');

CREATE TABLE "plantilla" (
    "id" UUID NOT NULL,
    "codigo" TEXT NOT NULL,
    "descripcion" TEXT,
    "asunto" TEXT NOT NULL,
    "cuerpo_html" TEXT NOT NULL,
    "cuerpo_texto" TEXT NOT NULL,
    "titulo_aviso" TEXT NOT NULL,
    "detalle_aviso" TEXT NOT NULL,
    "enlace_aviso" TEXT,
    "tono" "tono_aviso" NOT NULL DEFAULT 'info',
    "activa" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "plantilla_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "plantilla_codigo_key" ON "plantilla"("codigo");

CREATE TABLE "regla_aviso" (
    "id" UUID NOT NULL,
    "evento_tipo" TEXT NOT NULL,
    "rol_codigo" TEXT NOT NULL,
    "plantilla_id" UUID NOT NULL,
    "activa" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "regla_aviso_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "regla_aviso_evento_tipo_rol_codigo_key" ON "regla_aviso"("evento_tipo", "rol_codigo");
ALTER TABLE "regla_aviso" ADD CONSTRAINT "regla_aviso_plantilla_id_fkey" FOREIGN KEY ("plantilla_id") REFERENCES "plantilla"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "aviso" (
    "id" UUID NOT NULL,
    "usuario_id" UUID NOT NULL,
    "evento_id" UUID NOT NULL,
    "titulo" TEXT NOT NULL,
    "detalle" TEXT,
    "enlace" TEXT,
    "tono" "tono_aviso" NOT NULL DEFAULT 'info',
    "leido_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "aviso_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "aviso_evento_id_usuario_id_key" ON "aviso"("evento_id", "usuario_id");
CREATE INDEX "aviso_usuario_id_leido_at_idx" ON "aviso"("usuario_id", "leido_at");

CREATE TABLE "correo_aviso" (
    "id" UUID NOT NULL,
    "evento_id" UUID NOT NULL,
    "regla_id" UUID NOT NULL,
    "destinatario_nombre" TEXT,
    "destinatario_correo" TEXT,
    "enviado_a" TEXT NOT NULL,
    "asunto" TEXT NOT NULL,
    "estado" "estado_correo" NOT NULL,
    "error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "correo_aviso_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "correo_aviso_evento_id_idx" ON "correo_aviso"("evento_id");
ALTER TABLE "correo_aviso" ADD CONSTRAINT "correo_aviso_regla_id_fkey" FOREIGN KEY ("regla_id") REFERENCES "regla_aviso"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "correo_aviso" ADD CONSTRAINT "correo_aviso_error_check" CHECK (("estado" = 'fallido') = ("error" IS NOT NULL));

COMMENT ON TABLE "correo_aviso" IS 'Bitácora de correos: a quién habría llegado y a qué dirección salió de verdad (en pruebas, siempre la de redirección).';
