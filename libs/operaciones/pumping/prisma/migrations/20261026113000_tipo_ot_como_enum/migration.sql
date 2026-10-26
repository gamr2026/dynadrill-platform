-- OP-5 (PARIDAD-MODELO-DEMO.md): el tipo de orden de trabajo del ticket pasa de texto a enum, con los mismos valores que Comercial
-- (`pedido.tipo_ot`) y que FCR.
CREATE TYPE "tipo_ot" AS ENUM ('venta', 'servicio');
ALTER TABLE "ticket" ALTER COLUMN "tipo_ot" TYPE "tipo_ot" USING "tipo_ot"::"tipo_ot";
COMMENT ON COLUMN "ticket"."tipo_ot" IS 'Tipo de orden de trabajo del pedido (lo decide Ventas); copia del pedido.';
