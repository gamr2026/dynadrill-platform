-- Catálogo de tipos y subtipos de servicio (el subtipo depende de su tipo, 1:n) y su uso en el pedido.
-- Requisito: no hay filas en pedido_tipo_servicio / pedido_subtipo_servicio (a esta fecha no hay pedidos).

-- CreateTable
CREATE TABLE "servicio_tipo" (
    "codigo" TEXT NOT NULL,
    "linea_servicio" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "orden" INTEGER NOT NULL DEFAULT 0,
    "activo" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "servicio_tipo_pkey" PRIMARY KEY ("codigo")
);

-- CreateTable
CREATE TABLE "servicio_subtipo" (
    "id" UUID NOT NULL,
    "tipo_servicio" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "orden" INTEGER NOT NULL DEFAULT 0,
    "activo" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "servicio_subtipo_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "servicio_tipo_linea_servicio_idx" ON "servicio_tipo"("linea_servicio");
CREATE UNIQUE INDEX "servicio_subtipo_tipo_servicio_nombre_key" ON "servicio_subtipo"("tipo_servicio", "nombre");

-- El tipo del pedido ya no se valida con una lista fija: sale del catálogo.
ALTER TABLE "pedido_tipo_servicio" DROP CONSTRAINT "pedido_tipo_servicio_check";

-- El subtipo del pedido guarda su tipo.
DROP INDEX "pedido_subtipo_servicio_pedido_id_subtipo_key";
ALTER TABLE "pedido_subtipo_servicio" ADD COLUMN "tipo_servicio" TEXT NOT NULL;
CREATE UNIQUE INDEX "pedido_subtipo_servicio_pedido_id_tipo_servicio_subtipo_key"
  ON "pedido_subtipo_servicio"("pedido_id", "tipo_servicio", "subtipo");

-- AddForeignKey
ALTER TABLE "servicio_subtipo" ADD CONSTRAINT "servicio_subtipo_tipo_servicio_fkey"
  FOREIGN KEY ("tipo_servicio") REFERENCES "servicio_tipo"("codigo") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pedido_tipo_servicio" ADD CONSTRAINT "pedido_tipo_servicio_tipo_servicio_fkey"
  FOREIGN KEY ("tipo_servicio") REFERENCES "servicio_tipo"("codigo") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pedido_subtipo_servicio" ADD CONSTRAINT "pedido_subtipo_servicio_pedido_id_tipo_servicio_fkey"
  FOREIGN KEY ("pedido_id", "tipo_servicio") REFERENCES "pedido_tipo_servicio"("pedido_id", "tipo_servicio")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pedido_subtipo_servicio" ADD CONSTRAINT "pedido_subtipo_servicio_tipo_servicio_subtipo_fkey"
  FOREIGN KEY ("tipo_servicio", "subtipo") REFERENCES "servicio_subtipo"("tipo_servicio", "nombre")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Línea de servicio válida en el catálogo.
ALTER TABLE "servicio_tipo" ADD CONSTRAINT "servicio_tipo_linea_check" CHECK ("linea_servicio" IN ('fcr', 'pumping'));

COMMENT ON TABLE "servicio_tipo" IS 'Catálogo de tipos de servicio; cada uno pertenece a una línea de servicio.';
COMMENT ON TABLE "servicio_subtipo" IS 'Catálogo de subtipos de servicio; cada subtipo pertenece a un tipo (1:n).';
