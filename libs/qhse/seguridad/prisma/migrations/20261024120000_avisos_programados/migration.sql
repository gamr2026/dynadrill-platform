-- QHSE, avisos por vencimiento: lo que depende del tiempo (ART, requisitos legales, inspecciones, plazos de investigaciones, objetivos y controles
-- ambientales) no lo dispara ningún evento de negocio, así que un emisor programado revisa y publica eventos `qhse.aviso.*`; el módulo de Avisos de
-- la plataforma los convierte en campanita y correo con sus reglas y plantillas. Esta tabla guarda qué hechos ya se avisaron para no repetirlos.

CREATE TABLE "aviso_programado" (
    "clave" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "entidad_id" UUID NOT NULL,
    "fecha_limite" DATE,
    "emitido_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "aviso_programado_pkey" PRIMARY KEY ("clave"),
    CONSTRAINT "aviso_programado_clave_check" CHECK (length(btrim("clave")) > 0));
CREATE INDEX "aviso_programado_entidad_idx" ON "aviso_programado" ("tipo", "entidad_id");

COMMENT ON TABLE "aviso_programado" IS 'Hechos por vencimiento ya avisados. La clave identifica el hecho (tipo + entidad + fecha límite): si la fecha límite cambia (p. ej. una revisión nueva), es otro hecho y se avisa de nuevo.';
COMMENT ON COLUMN "aviso_programado"."entidad_id" IS 'Id de la entidad vencida (documento, revisión legal, investigación, acción, objetivo, aspecto o inspección). Sin FK: apunta a tablas distintas según el tipo.';

-- Solo se agrega: lo avisado no se reescribe ni se borra.
REVOKE UPDATE, DELETE ON "aviso_programado" FROM app_qhse;
