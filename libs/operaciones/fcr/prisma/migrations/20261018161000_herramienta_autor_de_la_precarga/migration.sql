-- La precarga de herramientas la hace el sistema al abrirse el pedido: su autor es quien abrió el pedido si es una cuenta de identidad,
-- y si el evento no la trae, queda sin autor. Una herramienta agregada a mano siempre tiene autor.
ALTER TABLE "ticket_herramienta" ALTER COLUMN "created_by" DROP NOT NULL, ALTER COLUMN "updated_by" DROP NOT NULL;
ALTER TABLE "ticket_herramienta"
  ADD CONSTRAINT "ticket_herramienta_autor_check" CHECK ("origen" = 'pedido' OR ("created_by" IS NOT NULL AND "updated_by" IS NOT NULL));
COMMENT ON COLUMN "ticket_herramienta"."created_by" IS 'Quien la agregó. En la precarga desde el pedido, quien abrió el pedido (nulo si la cuenta no existe en identidad); en las manuales, siempre una cuenta.';
