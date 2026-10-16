-- CreateTable
CREATE TABLE "documento" (
    "id" UUID NOT NULL,
    "codigo" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "nombre_as2" TEXT,
    "emite_portal" BOOLEAN NOT NULL DEFAULT true,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "documento_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "secuencia" (
    "id" UUID NOT NULL,
    "documento_id" UUID NOT NULL,
    "prefijo" TEXT,
    "sufijo" TEXT,
    "longitud" INTEGER NOT NULL DEFAULT 0,
    "rango_desde" INTEGER NOT NULL DEFAULT 1,
    "rango_hasta" INTEGER NOT NULL DEFAULT 999999,
    "numero_actual" INTEGER NOT NULL DEFAULT 0,
    "vigencia_desde" DATE,
    "vigencia_hasta" DATE,
    "hacer_cumplir_vigencia" BOOLEAN NOT NULL DEFAULT false,
    "reinicio" TEXT NOT NULL DEFAULT 'nunca',
    "anio" INTEGER,
    "origen" TEXT NOT NULL DEFAULT 'portal',
    "as2_numero_actual" INTEGER,
    "as2_sincronizado_at" TIMESTAMPTZ(6),
    "activa" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "secuencia_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "secuencia_emision" (
    "id" UUID NOT NULL,
    "secuencia_id" UUID NOT NULL,
    "numero" INTEGER NOT NULL,
    "codigo_formateado" TEXT NOT NULL,
    "documento_ref_id" UUID,
    "estado" TEXT NOT NULL DEFAULT 'emitido',
    "emitido_por" UUID,
    "emitido_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "motivo" TEXT,

    CONSTRAINT "secuencia_emision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "documento_codigo_key" ON "documento"("codigo");

-- CreateIndex
CREATE INDEX "secuencia_documento_id_idx" ON "secuencia"("documento_id");

-- CreateIndex
CREATE INDEX "secuencia_emision_documento_ref_id_idx" ON "secuencia_emision"("documento_ref_id");

-- CreateIndex
CREATE UNIQUE INDEX "secuencia_emision_secuencia_id_numero_key" ON "secuencia_emision"("secuencia_id", "numero");

-- AddForeignKey
ALTER TABLE "secuencia" ADD CONSTRAINT "secuencia_documento_id_fkey" FOREIGN KEY ("documento_id") REFERENCES "documento"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "secuencia_emision" ADD CONSTRAINT "secuencia_emision_secuencia_id_fkey" FOREIGN KEY ("secuencia_id") REFERENCES "secuencia"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Reglas y privilegios que Prisma no expresa --------------------------------------------------------

ALTER TABLE "documento" ADD CONSTRAINT "documento_codigo_check" CHECK ("codigo" ~ '^[a-z][a-z0-9_]*$');

ALTER TABLE "secuencia" ADD CONSTRAINT "secuencia_reinicio_check" CHECK ("reinicio" IN ('nunca', 'anual'));
ALTER TABLE "secuencia" ADD CONSTRAINT "secuencia_origen_check" CHECK ("origen" IN ('portal', 'as2'));
ALTER TABLE "secuencia" ADD CONSTRAINT "secuencia_anual_check" CHECK (("reinicio" = 'anual') = ("anio" IS NOT NULL));
ALTER TABLE "secuencia" ADD CONSTRAINT "secuencia_rango_check" CHECK ("rango_desde" >= 0 AND "rango_hasta" >= "rango_desde" AND "longitud" >= 0);
ALTER TABLE "secuencia" ADD CONSTRAINT "secuencia_numero_check" CHECK ("numero_actual" >= "rango_desde" - 1 AND "numero_actual" <= "rango_hasta");
-- Una sola secuencia activa por documento y año (el año es nulo en las que no se reinician).
CREATE UNIQUE INDEX "secuencia_una_activa_idx" ON "secuencia" ("documento_id", COALESCE("anio", 0)) WHERE "activa";

ALTER TABLE "secuencia_emision" ADD CONSTRAINT "secuencia_emision_estado_check"
  CHECK ("estado" IN ('emitido', 'anulado', 'huerfano'));

-- Bitácora de solo inserción: el número y su código nunca cambian. Solo se permite actualizar el estado, el motivo y
-- el documento al que se asignó (anular un número o enlazarlo después); nunca DELETE.
REVOKE UPDATE ON "secuencia_emision" FROM app_comercial;
GRANT UPDATE ("estado", "motivo", "documento_ref_id") ON "secuencia_emision" TO app_comercial;

COMMENT ON TABLE "documento" IS 'Documentos del ciclo comercial y cómo se numeran. emite_portal=false: el número lo asigna AS2 (p. ej. PEC-).';
COMMENT ON TABLE "secuencia" IS 'Contador de un documento (prefijo, longitud, rango, vigencia). Emitir un número es un UPDATE atómico dentro de la transacción del documento.';
COMMENT ON TABLE "secuencia_emision" IS 'Bitácora de cada número emitido. UNIQUE(secuencia_id, numero) impide duplicados; los estados permiten ver anulaciones y huérfanos.';
