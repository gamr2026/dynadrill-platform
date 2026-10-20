-- Fin del servicio del pedido: define cuándo queda libre el personal asignado al ticket.
ALTER TABLE "pumping"."ticket" ADD COLUMN "fecha_fin_servicio" DATE;
ALTER TABLE "pumping"."ticket" ADD CONSTRAINT "ticket_fechas_servicio_check" CHECK ("fecha_fin_servicio" IS NULL OR "fecha_inicio_servicio" IS NULL OR "fecha_fin_servicio" >= "fecha_inicio_servicio");
COMMENT ON COLUMN "pumping"."ticket"."fecha_fin_servicio" IS 'Fin del servicio según el pedido de Comercial (libera al personal asignado).';
