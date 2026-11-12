-- Pedido anulado: comercial publica `comercial.pedido.anulado` y la réplica de tickets de QHSE deja de estar viva. El ticket queda marcado como anulado
-- (con el motivo); los documentos, PTW y demás registros ya creados no se tocan, pero no se abren nuevos y no se generan tareas ni avisos.
ALTER TABLE "qhse"."ticket_ref"
  ADD COLUMN "anulado_at" TIMESTAMPTZ(6),
  ADD COLUMN "anulado_motivo" TEXT,
  ADD CONSTRAINT "ticket_ref_anulacion_check" CHECK ("anulado_motivo" IS NULL OR ("anulado_at" IS NOT NULL AND length(btrim("anulado_motivo")) > 0));

-- Una vez anulado no se reabre ni se cambia el motivo (repetir el evento no cambia nada).
CREATE FUNCTION "qhse"."ticket_ref_anulacion_firme"() RETURNS trigger LANGUAGE plpgsql SET search_path = qhse, pg_catalog AS $$
BEGIN
  IF OLD."anulado_at" IS NOT NULL AND (NEW."anulado_at", NEW."anulado_motivo") IS DISTINCT FROM (OLD."anulado_at", OLD."anulado_motivo") THEN
    RAISE EXCEPTION 'El ticket está anulado y no se puede reabrir' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "ticket_ref_anulacion_firme_trg" BEFORE UPDATE ON "qhse"."ticket_ref"
  FOR EACH ROW EXECUTE FUNCTION "qhse"."ticket_ref_anulacion_firme"();

CREATE INDEX "ticket_ref_anulado_idx" ON "qhse"."ticket_ref" ("anulado_at") WHERE "anulado_at" IS NOT NULL;

COMMENT ON COLUMN "qhse"."ticket_ref"."anulado_at" IS 'Cuándo comercial anuló el pedido del ticket (evento comercial.pedido.anulado). Un ticket anulado no recibe documentos, PTW, SWA, EPI ni inspecciones nuevos.';
COMMENT ON COLUMN "qhse"."ticket_ref"."anulado_motivo" IS 'Motivo de la anulación del pedido, tal como lo publicó comercial.';
