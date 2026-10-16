-- Los valores fijos y cerrados del sistema pasan de texto con CHECK a ENUM de PostgreSQL.

CREATE TYPE "tipo_vinculo" AS ENUM ('empleado', 'contratista', 'externo');
CREATE TYPE "accion_permiso" AS ENUM ('otorgado', 'revocado');
CREATE TYPE "estado_sincronizacion" AS ENUM ('en_curso', 'ok', 'error');
CREATE TYPE "origen_sincronizacion" AS ENUM ('manual', 'programada');

ALTER TABLE "usuario" DROP CONSTRAINT "usuario_tipo_vinculo_check";
ALTER TABLE "rol_permiso_historial" DROP CONSTRAINT "rol_permiso_historial_accion_check";
ALTER TABLE "sincronizacion_as2" DROP CONSTRAINT "sincronizacion_as2_estado_check";
ALTER TABLE "sincronizacion_as2" DROP CONSTRAINT "sincronizacion_as2_origen_check";

ALTER TABLE "usuario" ALTER COLUMN "tipo_vinculo" DROP DEFAULT;
ALTER TABLE "usuario" ALTER COLUMN "tipo_vinculo" TYPE "tipo_vinculo" USING "tipo_vinculo"::"tipo_vinculo";
ALTER TABLE "usuario" ALTER COLUMN "tipo_vinculo" SET DEFAULT 'empleado';
ALTER TABLE "rol_permiso_historial" ALTER COLUMN "accion" TYPE "accion_permiso" USING "accion"::"accion_permiso";
ALTER TABLE "sincronizacion_as2" ALTER COLUMN "estado" TYPE "estado_sincronizacion" USING "estado"::"estado_sincronizacion";
ALTER TABLE "sincronizacion_as2" ALTER COLUMN "origen" TYPE "origen_sincronizacion" USING "origen"::"origen_sincronizacion";
