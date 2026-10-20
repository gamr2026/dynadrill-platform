-- El representante del cliente en campo (el «Company Man») viene del pedido: el reporte diario lo muestra sin que el operador lo escriba.
-- Solo el id (FK al catálogo de personas de contacto); el nombre sale del JOIN.
GRANT SELECT (id, nombre) ON catalogos.persona_contacto TO app_operaciones;
ALTER TABLE "pumping"."ticket"
  ADD COLUMN "representante_campo_id" UUID,
  ADD CONSTRAINT "ticket_representante_campo_id_fkey" FOREIGN KEY ("representante_campo_id") REFERENCES catalogos.persona_contacto ("id");
COMMENT ON COLUMN "pumping"."ticket"."representante_campo_id" IS 'Representante del cliente en campo (Company Man) según el pedido.';
