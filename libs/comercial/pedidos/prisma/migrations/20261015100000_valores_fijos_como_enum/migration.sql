-- Los valores fijos y cerrados del sistema pasan de texto con CHECK a ENUM de PostgreSQL.

CREATE TYPE "origen_registro" AS ENUM ('portal', 'as2');
CREATE TYPE "estado_sync_as2" AS ENUM ('no_aplica', 'pendiente_de_crear_en_as2', 'vinculado', 'error');
CREATE TYPE "metodo_vinculo_as2" AS ENUM ('referencia_en_descripcion', 'manual', 'api');
CREATE TYPE "origen_item" AS ENUM ('lista', 'plantilla', 'as2', 'manual');
CREATE TYPE "macro_estado" AS ENUM ('borrador', 'pendiente', 'en_proceso', 'esperando_aprobacion', 'aprobado', 'rechazado');
CREATE TYPE "origen_cambio_estado" AS ENUM ('manual', 'automatico', 'sincronizacion', 'forzado', 'sistema');
CREATE TYPE "reinicio_secuencia" AS ENUM ('nunca', 'anual');
CREATE TYPE "estado_emision" AS ENUM ('emitido', 'anulado', 'huerfano');
CREATE TYPE "tipo_item_lista" AS ENUM ('Material', 'Servicio');

ALTER TABLE "pedido" DROP CONSTRAINT "pedido_origen_check";
ALTER TABLE "secuencia" DROP CONSTRAINT "secuencia_origen_check";
ALTER TABLE "pedido" DROP CONSTRAINT "pedido_as2_sync_check";
ALTER TABLE "pedido" DROP CONSTRAINT "pedido_as2_vinculo_check";
ALTER TABLE "pedido_item" DROP CONSTRAINT "pedido_item_origen_check";
ALTER TABLE "proceso_estado" DROP CONSTRAINT "proceso_estado_macro_check";
ALTER TABLE "proceso_historial" DROP CONSTRAINT "proceso_historial_origen_check";
ALTER TABLE "secuencia" DROP CONSTRAINT "secuencia_reinicio_check";
ALTER TABLE "secuencia_emision" DROP CONSTRAINT "secuencia_emision_estado_check";
ALTER TABLE "lista_precios_item" DROP CONSTRAINT "lista_precios_item_tipo_check";
ALTER TABLE "pedido" DROP CONSTRAINT "pedido_as2_origen_check";
ALTER TABLE "secuencia" DROP CONSTRAINT "secuencia_anual_check";

ALTER TABLE "pedido" ALTER COLUMN "origen" TYPE "origen_registro" USING "origen"::"origen_registro";
ALTER TABLE "secuencia" ALTER COLUMN "origen" DROP DEFAULT;
ALTER TABLE "secuencia" ALTER COLUMN "origen" TYPE "origen_registro" USING "origen"::"origen_registro";
ALTER TABLE "secuencia" ALTER COLUMN "origen" SET DEFAULT 'portal';
ALTER TABLE "pedido" ALTER COLUMN "as2_sync_estado" DROP DEFAULT;
ALTER TABLE "pedido" ALTER COLUMN "as2_sync_estado" TYPE "estado_sync_as2" USING "as2_sync_estado"::"estado_sync_as2";
ALTER TABLE "pedido" ALTER COLUMN "as2_sync_estado" SET DEFAULT 'no_aplica';
ALTER TABLE "pedido" ALTER COLUMN "as2_vinculo_metodo" TYPE "metodo_vinculo_as2" USING "as2_vinculo_metodo"::"metodo_vinculo_as2";
ALTER TABLE "pedido_item" ALTER COLUMN "origen_item" DROP DEFAULT;
ALTER TABLE "pedido_item" ALTER COLUMN "origen_item" TYPE "origen_item" USING "origen_item"::"origen_item";
ALTER TABLE "pedido_item" ALTER COLUMN "origen_item" SET DEFAULT 'lista';
ALTER TABLE "proceso_estado" ALTER COLUMN "macro_estado" TYPE "macro_estado" USING "macro_estado"::"macro_estado";
ALTER TABLE "proceso_historial" ALTER COLUMN "macro_estado" TYPE "macro_estado" USING "macro_estado"::"macro_estado";
ALTER TABLE "proceso_historial" ALTER COLUMN "origen" DROP DEFAULT;
ALTER TABLE "proceso_historial" ALTER COLUMN "origen" TYPE "origen_cambio_estado" USING "origen"::"origen_cambio_estado";
ALTER TABLE "proceso_historial" ALTER COLUMN "origen" SET DEFAULT 'manual';
ALTER TABLE "secuencia" ALTER COLUMN "reinicio" DROP DEFAULT;
ALTER TABLE "secuencia" ALTER COLUMN "reinicio" TYPE "reinicio_secuencia" USING "reinicio"::"reinicio_secuencia";
ALTER TABLE "secuencia" ALTER COLUMN "reinicio" SET DEFAULT 'nunca';
ALTER TABLE "secuencia_emision" ALTER COLUMN "estado" DROP DEFAULT;
ALTER TABLE "secuencia_emision" ALTER COLUMN "estado" TYPE "estado_emision" USING "estado"::"estado_emision";
ALTER TABLE "secuencia_emision" ALTER COLUMN "estado" SET DEFAULT 'emitido';
ALTER TABLE "lista_precios_item" ALTER COLUMN "tipo" TYPE "tipo_item_lista" USING "tipo"::"tipo_item_lista";

ALTER TABLE "pedido" ADD CONSTRAINT "pedido_as2_origen_check" CHECK ("origen" <> 'as2' OR "as2_id_pedido_cliente" IS NOT NULL);
ALTER TABLE "secuencia" ADD CONSTRAINT "secuencia_anual_check" CHECK (("reinicio" = 'anual') = ("anio" IS NOT NULL));
