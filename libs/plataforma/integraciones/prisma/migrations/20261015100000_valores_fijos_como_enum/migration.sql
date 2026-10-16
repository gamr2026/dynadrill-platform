-- Los valores fijos y cerrados del sistema pasan de texto con CHECK a ENUM de PostgreSQL.

CREATE TYPE "tipo_autenticacion" AS ENUM ('ninguna', 'bearer_login', 'api_key');
CREATE TYPE "estado_ejecucion" AS ENUM ('ok', 'error');
CREATE TYPE "transformacion_campo" AS ENUM ('texto', 'entero', 'numero', 'booleano', 'fecha_ms_ec', 'fecha_iso');
CREATE TYPE "metodo_http" AS ENUM ('GET', 'POST', 'PUT', 'PATCH');
CREATE TYPE "ambiente_proveedor" AS ENUM ('produccion', 'pruebas');

ALTER TABLE "autenticacion" DROP CONSTRAINT "autenticacion_tipo_check";
ALTER TABLE "ejecucion" DROP CONSTRAINT "ejecucion_estado_check";
ALTER TABLE "mapeo_campo" DROP CONSTRAINT "mapeo_campo_transformacion_check";
ALTER TABLE "operacion" DROP CONSTRAINT "operacion_metodo_check";
ALTER TABLE "proveedor" DROP CONSTRAINT "proveedor_ambiente_check";

ALTER TABLE "autenticacion" ALTER COLUMN "tipo" TYPE "tipo_autenticacion" USING "tipo"::"tipo_autenticacion";
ALTER TABLE "ejecucion" ALTER COLUMN "estado" TYPE "estado_ejecucion" USING "estado"::"estado_ejecucion";
ALTER TABLE "mapeo_campo" ALTER COLUMN "transformacion" TYPE "transformacion_campo" USING "transformacion"::"transformacion_campo";
ALTER TABLE "operacion" ALTER COLUMN "metodo" DROP DEFAULT;
ALTER TABLE "operacion" ALTER COLUMN "metodo" TYPE "metodo_http" USING "metodo"::"metodo_http";
ALTER TABLE "operacion" ALTER COLUMN "metodo" SET DEFAULT 'POST';
ALTER TABLE "proveedor" ALTER COLUMN "ambiente" TYPE "ambiente_proveedor" USING "ambiente"::"ambiente_proveedor";
