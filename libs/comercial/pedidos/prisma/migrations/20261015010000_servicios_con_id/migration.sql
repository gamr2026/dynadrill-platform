-- Catálogo de servicios con `id` UUID en cada tabla y claves foráneas por `id` (línea -> tipo -> subtipo), como el resto
-- del modelo. Antes se usaba el código de texto como clave primaria.
-- Requisito: ningún pedido tiene línea, tipos ni subtipos elegidos (se verificó antes de aplicar).

-- Se desarma lo anterior
ALTER TABLE "pedido" DROP CONSTRAINT "pedido_linea_servicio_fkey";
ALTER TABLE "pedido" DROP CONSTRAINT "pedido_completo_check";
DROP INDEX "pedido_linea_servicio_estado_idx";
ALTER TABLE "pedido" DROP COLUMN "linea_servicio";
DROP TABLE "pedido_subtipo_servicio";
DROP TABLE "pedido_tipo_servicio";
DROP TABLE "servicio_subtipo";
DROP TABLE "servicio_tipo";
DROP TABLE "servicio_linea";

-- Catálogo
CREATE TABLE "servicio_linea" (
    "id" UUID NOT NULL,
    "codigo" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "orden" INTEGER NOT NULL DEFAULT 0,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "servicio_linea_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "servicio_linea_codigo_key" ON "servicio_linea"("codigo");

CREATE TABLE "servicio_tipo" (
    "id" UUID NOT NULL,
    "linea_id" UUID NOT NULL,
    "codigo" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "orden" INTEGER NOT NULL DEFAULT 0,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "servicio_tipo_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "servicio_tipo_codigo_key" ON "servicio_tipo"("codigo");
CREATE INDEX "servicio_tipo_linea_id_idx" ON "servicio_tipo"("linea_id");

CREATE TABLE "servicio_subtipo" (
    "id" UUID NOT NULL,
    "tipo_id" UUID NOT NULL,
    "nombre" TEXT NOT NULL,
    "orden" INTEGER NOT NULL DEFAULT 0,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "servicio_subtipo_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "servicio_subtipo_tipo_id_nombre_key" ON "servicio_subtipo"("tipo_id", "nombre");
CREATE UNIQUE INDEX "servicio_subtipo_tipo_id_id_key" ON "servicio_subtipo"("tipo_id", "id");

ALTER TABLE "servicio_tipo" ADD CONSTRAINT "servicio_tipo_linea_id_fkey"
  FOREIGN KEY ("linea_id") REFERENCES "servicio_linea"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "servicio_subtipo" ADD CONSTRAINT "servicio_subtipo_tipo_id_fkey"
  FOREIGN KEY ("tipo_id") REFERENCES "servicio_tipo"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Pedido: línea por id
ALTER TABLE "pedido" ADD COLUMN "linea_id" UUID;
ALTER TABLE "pedido" ADD CONSTRAINT "pedido_linea_id_fkey"
  FOREIGN KEY ("linea_id") REFERENCES "servicio_linea"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "pedido_linea_id_estado_idx" ON "pedido"("linea_id", "estado");
ALTER TABLE "pedido" ADD CONSTRAINT "pedido_completo_check" CHECK (
  "estado" IN ('borrador', 'anulado') OR (
    "codigo" IS NOT NULL AND "cliente_id" IS NOT NULL AND "linea_id" IS NOT NULL AND "tipo_ot" IS NOT NULL
    AND "campo_id" IS NOT NULL AND "pozo_id" IS NOT NULL AND ("rigless" OR "taladro_id" IS NOT NULL)
    AND "numero_contrato" IS NOT NULL AND "fecha_inicio_servicio" IS NOT NULL AND "fecha_fin_servicio" IS NOT NULL
    AND "agente_comercial_id" IS NOT NULL AND "tecnico_hse_id" IS NOT NULL
  )
);

-- Tipos y subtipos elegidos en el pedido
CREATE TABLE "pedido_tipo_servicio" (
    "id" UUID NOT NULL,
    "pedido_id" UUID NOT NULL,
    "tipo_id" UUID NOT NULL,
    CONSTRAINT "pedido_tipo_servicio_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "pedido_tipo_servicio_pedido_id_tipo_id_key" ON "pedido_tipo_servicio"("pedido_id", "tipo_id");
ALTER TABLE "pedido_tipo_servicio" ADD CONSTRAINT "pedido_tipo_servicio_pedido_id_fkey"
  FOREIGN KEY ("pedido_id") REFERENCES "pedido"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pedido_tipo_servicio" ADD CONSTRAINT "pedido_tipo_servicio_tipo_id_fkey"
  FOREIGN KEY ("tipo_id") REFERENCES "servicio_tipo"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- El subtipo cuelga de un tipo que el MISMO pedido tiene elegido (FK compuesta) y de un subtipo que pertenece a ESE tipo
-- (FK compuesta al catálogo). No lleva FK directa a pedido: ya queda garantizado a través del tipo.
CREATE TABLE "pedido_subtipo_servicio" (
    "id" UUID NOT NULL,
    "pedido_id" UUID NOT NULL,
    "tipo_id" UUID NOT NULL,
    "subtipo_id" UUID NOT NULL,
    CONSTRAINT "pedido_subtipo_servicio_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "pedido_subtipo_servicio_pedido_id_subtipo_id_key" ON "pedido_subtipo_servicio"("pedido_id", "subtipo_id");
ALTER TABLE "pedido_subtipo_servicio" ADD CONSTRAINT "pedido_subtipo_servicio_pedido_id_tipo_id_fkey"
  FOREIGN KEY ("pedido_id", "tipo_id") REFERENCES "pedido_tipo_servicio"("pedido_id", "tipo_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pedido_subtipo_servicio" ADD CONSTRAINT "pedido_subtipo_servicio_tipo_id_subtipo_id_fkey"
  FOREIGN KEY ("tipo_id", "subtipo_id") REFERENCES "servicio_subtipo"("tipo_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Los tipos y subtipos del pedido se reemplazan al editar.
GRANT DELETE ON "pedido_tipo_servicio", "pedido_subtipo_servicio" TO app_comercial;

COMMENT ON TABLE "servicio_linea" IS 'Catálogo de líneas de servicio (FCR, Pumping...).';
COMMENT ON TABLE "servicio_tipo" IS 'Catálogo de tipos de servicio; cada uno pertenece a una línea.';
COMMENT ON TABLE "servicio_subtipo" IS 'Catálogo de subtipos de servicio; cada subtipo pertenece a un tipo (1:n).';
