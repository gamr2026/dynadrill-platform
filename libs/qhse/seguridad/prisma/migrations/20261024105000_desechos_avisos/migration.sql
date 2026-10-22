-- QHSE, tramo Q4: Desechos, avisos de vencimiento. Registra qué aviso se emitió de cada desecho para no repetirlo: el límite de almacenamiento
-- (AM 142, 12 meses) próximo o vencido, y el certificado de disposición final fuera del plazo de 30 días desde el manifiesto. La revisión la
-- dispara quien tenga el permiso (o un temporizador externo, que QHSE aún no tiene); es idempotente gracias a la clave única.

CREATE TYPE "tipo_aviso_desecho" AS ENUM ('limite_proximo', 'limite_vencido', 'certificado_vencido');

CREATE TABLE "desecho_aviso" (
    "id" UUID NOT NULL,
    "desecho_id" UUID NOT NULL,
    "tipo" "tipo_aviso_desecho" NOT NULL,
    "emitido_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "emitido_por" UUID NOT NULL,
    CONSTRAINT "desecho_aviso_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "desecho_aviso_unico_key" UNIQUE ("desecho_id", "tipo"),
    CONSTRAINT "desecho_aviso_desecho_fkey" FOREIGN KEY ("desecho_id") REFERENCES "desecho" ("id") ON DELETE CASCADE,
    CONSTRAINT "desecho_aviso_emitido_por_fkey" FOREIGN KEY ("emitido_por") REFERENCES identidad.usuario ("id")
);

-- Un aviso emitido es historia: no se edita ni se borra.
REVOKE UPDATE, DELETE ON "desecho_aviso" FROM app_qhse;

COMMENT ON TABLE "desecho_aviso" IS 'Avisos de vencimiento ya emitidos por desecho (uno de cada tipo): evita repetirlos. Inmutable.';
COMMENT ON COLUMN "desecho_aviso"."emitido_por" IS 'Quien disparó la revisión que emitió el aviso.';
