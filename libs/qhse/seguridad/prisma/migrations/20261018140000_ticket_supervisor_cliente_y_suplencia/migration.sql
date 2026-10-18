-- QHSE: (1) el supervisor asignado al ticket, para saber si quien sube el Acta de Entrega es otro supervisor (suplencia con motivo);
-- (2) cliente, campo y pozo del ticket, que la bandeja de documentos y los avisos muestran (respuesta de Dynadrill del 18/10/2026).

ALTER TABLE "ticket_ref" ADD COLUMN "supervisor_id" UUID;
ALTER TABLE "ticket_ref" ADD CONSTRAINT "ticket_ref_supervisor_fkey" FOREIGN KEY ("supervisor_id") REFERENCES identidad.usuario ("id");
ALTER TABLE "ticket_ref" ADD COLUMN "cliente" TEXT;
ALTER TABLE "ticket_ref" ADD COLUMN "campo" TEXT;
ALTER TABLE "ticket_ref" ADD COLUMN "pozo" TEXT;
CREATE INDEX "ticket_ref_supervisor_idx" ON "ticket_ref" ("supervisor_id");

COMMENT ON COLUMN "ticket_ref"."supervisor_id" IS 'Supervisor asignado al ticket (cuenta de identidad, FK real). Lo fija el evento asignacion_realizada; sirve para exigir un motivo cuando otro supervisor sube el Acta de Entrega.';
COMMENT ON COLUMN "ticket_ref"."cliente" IS 'COPIA justificada: nombre del cliente del pedido. La bandeja de documentos y los avisos de QHSE lo muestran y no se puede obtener con un JOIN (otro contenedor). Se mantiene por evento (ticket_creado y asignacion_realizada).';
COMMENT ON COLUMN "ticket_ref"."campo" IS 'COPIA justificada: campo del pedido, por la misma razón que cliente. Se mantiene por evento.';
COMMENT ON COLUMN "ticket_ref"."pozo" IS 'COPIA justificada: pozo del pedido, por la misma razón que cliente. Se mantiene por evento.';

-- Suplencia: si el Acta la sube alguien que no es el supervisor asignado, debe decir por qué el asignado no pudo.
ALTER TABLE "documento_pedido" ADD COLUMN "motivo_suplencia" TEXT;
ALTER TABLE "documento_pedido" ADD CONSTRAINT "documento_pedido_suplencia_check" CHECK (
  "motivo_suplencia" IS NULL OR ("tipo" = 'formato_entrega' AND length(btrim("motivo_suplencia")) > 0));

CREATE FUNCTION "documento_pedido_suplencia"() RETURNS trigger LANGUAGE plpgsql SET search_path = qhse, pg_catalog AS $$
DECLARE v_supervisor uuid;
BEGIN
  IF NEW."tipo" = 'formato_entrega' THEN
    SELECT "supervisor_id" INTO v_supervisor FROM qhse."ticket_ref" WHERE "ticket_id" = NEW."ticket_id";
    IF v_supervisor IS NOT NULL AND v_supervisor <> NEW."created_by" AND NEW."motivo_suplencia" IS NULL THEN
      RAISE EXCEPTION 'El Acta la sube el supervisor asignado al ticket; si la sube otra persona debe indicar por qué el asignado no pudo' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "documento_pedido_suplencia_trg" BEFORE INSERT ON "documento_pedido"
  FOR EACH ROW EXECUTE FUNCTION "documento_pedido_suplencia"();
COMMENT ON COLUMN "documento_pedido"."motivo_suplencia" IS 'Solo el Acta: por qué la subió otra persona y no el supervisor asignado al ticket (lo exige el trigger documento_pedido_suplencia).';
