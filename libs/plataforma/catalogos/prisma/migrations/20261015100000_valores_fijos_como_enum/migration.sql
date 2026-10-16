-- Los valores fijos y cerrados del sistema pasan de texto con CHECK a ENUM de PostgreSQL.

CREATE TYPE "tipo_persona" AS ENUM ('representante_campo', 'representante_quito', 'analista_facturacion', 'agente_comercial');

ALTER TABLE "persona_contacto" DROP CONSTRAINT "persona_contacto_tipo_check";

ALTER TABLE "persona_contacto" ALTER COLUMN "tipo" TYPE "tipo_persona" USING "tipo"::"tipo_persona";
