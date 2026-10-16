-- Bodegas y condiciones de pago como catálogos compartidos (antes eran texto suelto en el pedido).
CREATE TABLE "bodega" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "as2_id" INTEGER,
    "nombre" TEXT NOT NULL,
    "habilitado" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "bodega_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "bodega_as2_id_key" ON "bodega"("as2_id");
CREATE UNIQUE INDEX "bodega_nombre_key" ON "bodega"("nombre");

CREATE TABLE "condicion_pago" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "as2_id" INTEGER,
    "nombre" TEXT NOT NULL,
    "habilitado" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "condicion_pago_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "condicion_pago_as2_id_key" ON "condicion_pago"("as2_id");
CREATE UNIQUE INDEX "condicion_pago_nombre_key" ON "condicion_pago"("nombre");

COMMENT ON TABLE "bodega" IS 'Catálogo de bodegas; as2_id enlaza con la bodega de AS2.';
COMMENT ON TABLE "condicion_pago" IS 'Catálogo de condiciones de pago; as2_id enlaza con la condición de AS2.';
