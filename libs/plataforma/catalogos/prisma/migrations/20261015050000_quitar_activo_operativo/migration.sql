-- El activo operativo de Petroecuador (AIT, AM, AP...) no se usa en el negocio: se elimina junto con su catálogo.
ALTER TABLE "campo" DROP CONSTRAINT "campo_activo_operativo_id_fkey";
DROP INDEX "campo_activo_operativo_id_idx";
ALTER TABLE "campo" DROP COLUMN "activo_operativo_id";
DROP TABLE "activo_operativo";
