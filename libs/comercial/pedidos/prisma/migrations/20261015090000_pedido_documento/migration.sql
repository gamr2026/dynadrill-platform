-- Documentos adjuntos del pedido. El archivo se guarda en el módulo `archivos` (plataforma); aquí su id y una copia de
-- nombre, tipo y tamaño. Sin FK entre schemas.
CREATE TABLE "pedido_documento" (
    "id" UUID NOT NULL,
    "pedido_id" UUID NOT NULL,
    "archivo_id" UUID NOT NULL,
    "nombre" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "tamano_bytes" BIGINT NOT NULL,
    "subido_por" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "pedido_documento_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "pedido_documento_pedido_id_archivo_id_key" ON "pedido_documento"("pedido_id", "archivo_id");
CREATE INDEX "pedido_documento_pedido_id_idx" ON "pedido_documento"("pedido_id");
ALTER TABLE "pedido_documento" ADD CONSTRAINT "pedido_documento_pedido_id_fkey"
  FOREIGN KEY ("pedido_id") REFERENCES "pedido"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pedido_documento" ADD CONSTRAINT "pedido_documento_tamano_check" CHECK ("tamano_bytes" > 0);

-- Se pueden quitar los adjuntos mientras el pedido es editable.
GRANT DELETE ON "pedido_documento" TO app_comercial;

COMMENT ON TABLE "pedido_documento" IS 'Documentos adjuntos del pedido; el contenido está en archivos.archivo (plataforma).';
