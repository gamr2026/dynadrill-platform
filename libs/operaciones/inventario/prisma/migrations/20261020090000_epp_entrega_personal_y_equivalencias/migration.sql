-- EPP de AS2 (categoría «EQUIPO PROTECCION PERSONAL (EPP)»): el equipo de protección es un artículo de Inventario. Se agrega lo que
-- QHSE necesita para entregarlo a una persona y la trazabilidad de los productos de AS2 que se fusionan en un artículo.
--
--   1. `tipo_talla` y `entrega_personal` en el artículo: qué se entrega a una persona (formato DYN-SGI-RE-032) y con qué talla.
--      La talla NO forma parte del artículo (AS2 la tenía en el nombre, como productos aparte): se elige al entregar.
--   2. `articulo_equivalencia`: códigos de AS2 que se fusionaron en un artículo (tallas que eran productos, duplicados, errores de
--      digitación), para poder conciliar con AS2 por cualquiera de esos códigos.

CREATE TYPE "tipo_talla" AS ENUM ('ropa', 'calzado', 'guante');
CREATE TYPE "motivo_equivalencia" AS ENUM ('talla', 'duplicado', 'digitacion');

ALTER TABLE "articulo"
    ADD COLUMN "entrega_personal" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "tipo_talla" "tipo_talla";
-- solo un artículo que se entrega a una persona lleva talla
ALTER TABLE "articulo" ADD CONSTRAINT "articulo_tipo_talla_check" CHECK ("tipo_talla" IS NULL OR "entrega_personal");
CREATE INDEX "articulo_entrega_personal_idx" ON "articulo" ("id") WHERE "entrega_personal";

CREATE TABLE "articulo_equivalencia" (
    "id" UUID NOT NULL,
    "articulo_id" UUID NOT NULL,
    "codigo" TEXT NOT NULL,
    "motivo" "motivo_equivalencia" NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    CONSTRAINT "articulo_equivalencia_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "articulo_equivalencia_articulo_fkey" FOREIGN KEY ("articulo_id") REFERENCES "articulo" ("id") ON DELETE CASCADE,
    CONSTRAINT "articulo_equivalencia_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "articulo_equivalencia_codigo_check" CHECK (length(btrim("codigo")) > 0)
);
-- un código de AS2 equivale a un solo artículo, y no puede ser a la vez el código principal de otro (lo valida la carga)
CREATE UNIQUE INDEX "articulo_equivalencia_codigo_key" ON "articulo_equivalencia" ("codigo");
CREATE INDEX "articulo_equivalencia_articulo_id_idx" ON "articulo_equivalencia" ("articulo_id");

COMMENT ON COLUMN "articulo"."entrega_personal" IS 'El artículo se entrega a una persona (EPI y ropa de trabajo, formato DYN-SGI-RE-032). QHSE lo recibe por el evento inventario.articulo.epi_actualizado.';
COMMENT ON COLUMN "articulo"."tipo_talla" IS 'Tipo de talla que admite al entregarse (ropa, calzado o guante); nulo = no lleva talla. La talla no es parte del artículo.';
COMMENT ON TABLE "articulo_equivalencia" IS 'Códigos de producto de AS2 fusionados en este artículo (tallas que AS2 manejaba como productos, duplicados y errores de digitación).';
