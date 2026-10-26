-- CM-2 (PARIDAD-MODELO-DEMO.md): el rechazo de la prefactura por el cliente guarda lo que la demo guarda: los ítems observados (con su
-- observación), la persona a quien se devuelve la corrección (con FK, aunque cambie de pozo; el área sigue) y el seguimiento de la
-- corrección como filas fechadas, no como un texto único.

-- 1) Persona a quien se devuelve la corrección
ALTER TABLE "prefactura"
  ADD COLUMN "rechazo_devuelto_a_usuario_id" UUID,
  ADD CONSTRAINT "prefactura_rechazo_devuelto_a_usuario_id_fkey" FOREIGN KEY ("rechazo_devuelto_a_usuario_id") REFERENCES identidad.usuario ("id"),
  ADD CONSTRAINT "prefactura_rechazo_devuelto_a_usuario_check"
    CHECK ("rechazo_devuelto_a_usuario_id" IS NULL OR "estado" = 'rechazada');
COMMENT ON COLUMN "prefactura"."rechazo_devuelto_a_usuario_id" IS 'Persona a quien Facturación devuelve la corrección de la prefactura rechazada (el área va aparte, en `rechazo_devuelto_a`).';

-- 2) Ítems observados: solo se pueden observar ítems de la misma prefactura (FK compuesta)
ALTER TABLE "prefactura_item" ADD CONSTRAINT "prefactura_item_id_prefactura_key" UNIQUE ("id", "prefactura_id");

CREATE TABLE "prefactura_rechazo_item" (
    "id" UUID NOT NULL,
    "prefactura_id" UUID NOT NULL,
    "prefactura_item_id" UUID NOT NULL,
    "observacion" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    CONSTRAINT "prefactura_rechazo_item_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "prefactura_rechazo_item_prefactura_fkey" FOREIGN KEY ("prefactura_id") REFERENCES "prefactura" ("id") ON DELETE CASCADE,
    CONSTRAINT "prefactura_rechazo_item_item_fkey" FOREIGN KEY ("prefactura_item_id", "prefactura_id") REFERENCES "prefactura_item" ("id", "prefactura_id") ON DELETE CASCADE,
    CONSTRAINT "prefactura_rechazo_item_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "prefactura_rechazo_item_observacion_check" CHECK (length(btrim("observacion")) > 0),
    CONSTRAINT "prefactura_rechazo_item_key" UNIQUE ("prefactura_id", "prefactura_item_id")
);
-- lo observado es historia del rechazo: no se cambia ni se borra
REVOKE UPDATE, DELETE ON "prefactura_rechazo_item" FROM app_comercial;
COMMENT ON TABLE "prefactura_rechazo_item" IS 'Ítems de una prefactura que el cliente observó al rechazarla, con la observación de cada uno. Inmutable.';

-- 3) Seguimiento de la corrección: una fila por nota, con quién y cuándo
CREATE TABLE "prefactura_seguimiento" (
    "id" UUID NOT NULL,
    "prefactura_id" UUID NOT NULL,
    "nota" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    CONSTRAINT "prefactura_seguimiento_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "prefactura_seguimiento_prefactura_fkey" FOREIGN KEY ("prefactura_id") REFERENCES "prefactura" ("id") ON DELETE CASCADE,
    CONSTRAINT "prefactura_seguimiento_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "prefactura_seguimiento_nota_check" CHECK (length(btrim("nota")) > 0)
);
CREATE INDEX "prefactura_seguimiento_prefactura_idx" ON "prefactura_seguimiento" ("prefactura_id", "created_at");
REVOKE UPDATE, DELETE ON "prefactura_seguimiento" FROM app_comercial;
COMMENT ON TABLE "prefactura_seguimiento" IS 'Seguimiento de la corrección de una prefactura rechazada: una nota por fila, con quién y cuándo. Inmutable.';

-- 4) Las notas de seguimiento y los ítems observados solo existen en una prefactura rechazada
CREATE FUNCTION "comercial"."exigir_prefactura_rechazada"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "comercial"."prefactura" WHERE "id" = NEW."prefactura_id" AND "estado" = 'rechazada') THEN
    RAISE EXCEPTION 'Solo una prefactura rechazada tiene ítems observados o seguimiento de la corrección';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "exigir_prefactura_rechazada" BEFORE INSERT ON "comercial"."prefactura_rechazo_item"
  FOR EACH ROW EXECUTE FUNCTION "comercial"."exigir_prefactura_rechazada"();
CREATE TRIGGER "exigir_prefactura_rechazada" BEFORE INSERT ON "comercial"."prefactura_seguimiento"
  FOR EACH ROW EXECUTE FUNCTION "comercial"."exigir_prefactura_rechazada"();
