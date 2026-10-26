-- OP-3 (PARIDAD-MODELO-DEMO.md): el representante del cliente (Company Man) del Reporte Diario deja de ser texto y pasa a ser FK al
-- catálogo de contactos, como ya lo es el del ticket (`ticket.representante_campo_id`, que viene del pedido). El servicio lo precarga con el del
-- ticket al crear cada día; se puede cambiar si ese día firmó otro. El cargo no se guarda: es el del tipo de contacto (representante de campo).

ALTER TABLE "reporte_diario" ADD COLUMN "representante_id" UUID;

-- los días ya escritos con un nombre se enlazan al contacto del mismo nombre
UPDATE "reporte_diario" r
   SET "representante_id" = p."id"
  FROM catalogos.persona_contacto p
 WHERE p."tipo" = 'representante_campo'
   AND lower(btrim(p."nombre")) = lower(btrim(r."representante_cliente"));
-- los que no tienen contacto con ese nombre toman el del ticket
UPDATE "reporte_diario" r
   SET "representante_id" = t."representante_campo_id"
  FROM "ticket" t
 WHERE t."id" = r."ticket_id" AND r."representante_id" IS NULL AND btrim(COALESCE(r."representante_cliente", '')) <> '';

ALTER TABLE "reporte_diario"
  ADD CONSTRAINT "reporte_diario_representante_id_fkey" FOREIGN KEY ("representante_id") REFERENCES catalogos.persona_contacto ("id"),
  DROP COLUMN "representante_cliente",
  DROP COLUMN "cargo_representante";
CREATE INDEX "reporte_diario_representante_id_idx" ON "reporte_diario" ("representante_id");

-- el tipo de contacto se lee para validar que sea de campo (la trigger corre con el rol de la aplicación)
GRANT SELECT (tipo) ON catalogos.persona_contacto TO app_operaciones;

-- el representante tiene que ser un contacto de campo del cliente (la FK sola admitiría un analista o un agente comercial)
CREATE FUNCTION "pumping"."validar_representante_reporte_diario"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."representante_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM catalogos.persona_contacto WHERE "id" = NEW."representante_id" AND "tipo" = 'representante_campo'
  ) THEN
    RAISE EXCEPTION 'El representante del reporte diario debe ser un representante de campo del catálogo de contactos';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "validar_representante_reporte_diario" BEFORE INSERT OR UPDATE OF "representante_id" ON "pumping"."reporte_diario"
  FOR EACH ROW EXECUTE FUNCTION "pumping"."validar_representante_reporte_diario"();

COMMENT ON COLUMN "reporte_diario"."representante_id" IS 'Company Man del cliente que firmó ese día (catálogo de contactos, tipo representante de campo). Se precarga con el del ticket y se puede cambiar.';
