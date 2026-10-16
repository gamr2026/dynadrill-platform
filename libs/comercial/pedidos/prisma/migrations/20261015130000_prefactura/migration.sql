-- Prefactura normalizada: cabecera con versiones, líneas, avisos y firmas. Sin JSON.
CREATE TYPE "estado_prefactura" AS ENUM ('generada', 'enviada_para_firmas', 'firmada', 'rechazada', 'anulada');
CREATE TYPE "medio_envio_prefactura" AS ENUM ('email', 'portal');
CREATE TYPE "fuente_item_prefactura" AS ENUM ('herramienta', 'material', 'personal', 'personal_manual');
CREATE TYPE "tipo_firmante" AS ENUM ('company_man', 'cliente', 'dynadrill');
CREATE TYPE "verificacion_firma" AS ENUM ('no_verificada', 'firma_detectada', 'firma_no_detectada');
CREATE TYPE "area_devolucion" AS ENUM ('ventas', 'operaciones', 'facturacion');
CREATE TYPE "tipo_tasa" AS ENUM ('iva', 'retencion_ir', 'retencion_iva');

CREATE TABLE "tasa_impuesto" (
    "id" UUID NOT NULL,
    "tipo" "tipo_tasa" NOT NULL,
    "porcentaje" DECIMAL(5,2) NOT NULL,
    "vigente_desde" DATE NOT NULL,
    CONSTRAINT "tasa_impuesto_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "tasa_impuesto_tipo_vigente_desde_key" ON "tasa_impuesto"("tipo", "vigente_desde");
ALTER TABLE "tasa_impuesto" ADD CONSTRAINT "tasa_impuesto_porcentaje_check" CHECK ("porcentaje" >= 0 AND "porcentaje" <= 100);

CREATE TABLE "prefactura" (
    "id" UUID NOT NULL,
    "pedido_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "estado" "estado_prefactura" NOT NULL DEFAULT 'generada',
    "ticket_numero" INTEGER,
    "lista_precios_id" UUID,
    "subtotal_servicios" DECIMAL(14,2) NOT NULL,
    "subtotal_materiales" DECIMAL(14,2) NOT NULL,
    "subtotal" DECIMAL(14,2) NOT NULL,
    "iva" DECIMAL(14,2) NOT NULL,
    "retencion_ir" DECIMAL(14,2) NOT NULL,
    "retencion_iva" DECIMAL(14,2) NOT NULL,
    "neto_cobrar" DECIMAL(14,2) NOT NULL,
    "iva_pct" DECIMAL(5,2) NOT NULL,
    "retencion_ir_pct" DECIMAL(5,2) NOT NULL,
    "retencion_iva_pct" DECIMAL(5,2) NOT NULL,
    "generada_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "generada_por" UUID NOT NULL,
    "enviada_at" TIMESTAMPTZ(6),
    "enviada_por" UUID,
    "medio_envio" "medio_envio_prefactura",
    "razon_retraso" TEXT,
    "firmada_at" TIMESTAMPTZ(6),
    "rechazada_at" TIMESTAMPTZ(6),
    "rechazada_por" UUID,
    "rechazo_motivo" TEXT,
    "rechazo_devuelto_a" "area_devolucion",
    "anulada_at" TIMESTAMPTZ(6),
    "anulada_por" UUID,
    "anulacion_motivo" TEXT,
    CONSTRAINT "prefactura_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "prefactura_pedido_id_version_key" ON "prefactura"("pedido_id", "version");
CREATE INDEX "prefactura_pedido_id_idx" ON "prefactura"("pedido_id");
ALTER TABLE "prefactura" ADD CONSTRAINT "prefactura_pedido_id_fkey"
  FOREIGN KEY ("pedido_id") REFERENCES "pedido"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "prefactura" ADD CONSTRAINT "prefactura_lista_precios_id_fkey"
  FOREIGN KEY ("lista_precios_id") REFERENCES "lista_precios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Solo una prefactura VIGENTE por pedido (generada, enviada o firmada); las rechazadas y anuladas quedan de historial.
CREATE UNIQUE INDEX "prefactura_una_vigente_idx" ON "prefactura"("pedido_id")
  WHERE "estado" IN ('generada', 'enviada_para_firmas', 'firmada');
-- El número de ticket (el PRC- de AS2) no se repite entre prefacturas vigentes de pedidos distintos.
CREATE UNIQUE INDEX "prefactura_ticket_numero_idx" ON "prefactura"("ticket_numero")
  WHERE "ticket_numero" IS NOT NULL AND "estado" IN ('generada', 'enviada_para_firmas', 'firmada');
ALTER TABLE "prefactura" ADD CONSTRAINT "prefactura_ticket_check" CHECK ("ticket_numero" IS NULL OR "ticket_numero" > 0);
ALTER TABLE "prefactura" ADD CONSTRAINT "prefactura_version_check" CHECK ("version" >= 1);
ALTER TABLE "prefactura" ADD CONSTRAINT "prefactura_montos_check"
  CHECK ("subtotal_servicios" >= 0 AND "subtotal_materiales" >= 0 AND "subtotal" >= 0);
ALTER TABLE "prefactura" ADD CONSTRAINT "prefactura_enviada_check"
  CHECK ("estado" NOT IN ('enviada_para_firmas', 'firmada') OR ("enviada_at" IS NOT NULL AND "medio_envio" IS NOT NULL));
ALTER TABLE "prefactura" ADD CONSTRAINT "prefactura_firmada_check"
  CHECK (("estado" = 'firmada') = ("firmada_at" IS NOT NULL));
ALTER TABLE "prefactura" ADD CONSTRAINT "prefactura_rechazada_check"
  CHECK ("estado" <> 'rechazada' OR ("rechazada_at" IS NOT NULL AND "rechazo_motivo" IS NOT NULL AND "rechazo_devuelto_a" IS NOT NULL));
ALTER TABLE "prefactura" ADD CONSTRAINT "prefactura_anulada_check"
  CHECK ("estado" <> 'anulada' OR ("anulada_at" IS NOT NULL AND "anulacion_motivo" IS NOT NULL));

CREATE TABLE "prefactura_item" (
    "id" UUID NOT NULL,
    "prefactura_id" UUID NOT NULL,
    "orden" INTEGER NOT NULL,
    "codigo" TEXT NOT NULL,
    "descripcion" TEXT NOT NULL,
    "unidad" TEXT,
    "serie" TEXT,
    "cantidad" DECIMAL(14,3) NOT NULL,
    "precio_unitario" DECIMAL(14,2) NOT NULL,
    "descuento_pct" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "precio_total" DECIMAL(14,2) NOT NULL,
    "tipo" "tipo_item_lista" NOT NULL,
    "fuente" "fuente_item_prefactura" NOT NULL,
    CONSTRAINT "prefactura_item_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "prefactura_item_prefactura_id_orden_key" ON "prefactura_item"("prefactura_id", "orden");
ALTER TABLE "prefactura_item" ADD CONSTRAINT "prefactura_item_prefactura_id_fkey"
  FOREIGN KEY ("prefactura_id") REFERENCES "prefactura"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "prefactura_item" ADD CONSTRAINT "prefactura_item_cantidad_check" CHECK ("cantidad" > 0);
ALTER TABLE "prefactura_item" ADD CONSTRAINT "prefactura_item_precio_check" CHECK ("precio_unitario" >= 0 AND "precio_total" >= 0);
ALTER TABLE "prefactura_item" ADD CONSTRAINT "prefactura_item_descuento_check" CHECK ("descuento_pct" >= 0 AND "descuento_pct" <= 100);

CREATE TABLE "prefactura_advertencia" (
    "id" UUID NOT NULL,
    "prefactura_id" UUID NOT NULL,
    "orden" INTEGER NOT NULL,
    "mensaje" TEXT NOT NULL,
    CONSTRAINT "prefactura_advertencia_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "prefactura_advertencia_prefactura_id_orden_key" ON "prefactura_advertencia"("prefactura_id", "orden");
ALTER TABLE "prefactura_advertencia" ADD CONSTRAINT "prefactura_advertencia_prefactura_id_fkey"
  FOREIGN KEY ("prefactura_id") REFERENCES "prefactura"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "prefactura_firma" (
    "id" UUID NOT NULL,
    "prefactura_id" UUID NOT NULL,
    "firmante_tipo" "tipo_firmante" NOT NULL,
    "persona_id" UUID,
    "nombre" TEXT NOT NULL,
    "cargo" TEXT,
    "firmado_at" DATE NOT NULL,
    "archivo_id" UUID NOT NULL,
    "archivo_nombre" TEXT NOT NULL,
    "verificacion" "verificacion_firma" NOT NULL DEFAULT 'no_verificada',
    "registrado_por" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "prefactura_firma_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "prefactura_firma_prefactura_id_archivo_id_key" ON "prefactura_firma"("prefactura_id", "archivo_id");
CREATE INDEX "prefactura_firma_prefactura_id_idx" ON "prefactura_firma"("prefactura_id");
ALTER TABLE "prefactura_firma" ADD CONSTRAINT "prefactura_firma_prefactura_id_fkey"
  FOREIGN KEY ("prefactura_id") REFERENCES "prefactura"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Los totales y las líneas de una prefactura no se editan: al recalcular se reemplazan las líneas; los avisos y firmas se
-- agregan. La aplicación necesita DELETE solo en líneas y avisos (se reescriben al recalcular).
GRANT DELETE ON "prefactura_item", "prefactura_advertencia" TO app_comercial;

COMMENT ON TABLE "prefactura" IS 'Prefactura del pedido; una vigente por pedido, con versiones al regenerar tras un rechazo.';
COMMENT ON TABLE "tasa_impuesto" IS 'IVA y retenciones con su vigencia.';
