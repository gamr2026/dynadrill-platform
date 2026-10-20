-- El ticket de Operaciones (Pumping o FCR) que atiende a cada pedido y el paso en que va: Facturación ve la fase sin entrar a Operaciones.
-- Solo el código del paso (su nombre es del catálogo de Operaciones); lo mantiene el consumidor de los eventos del ticket.
CREATE TABLE "pedido_ticket_operativo" (
    "pedido_id" UUID NOT NULL,
    "origen" "origen_operativo" NOT NULL,
    "ticket_id" UUID NOT NULL,
    "paso_codigo" TEXT NOT NULL,
    "actualizado_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "pedido_ticket_operativo_pkey" PRIMARY KEY ("pedido_id")
);
ALTER TABLE "pedido_ticket_operativo" ADD CONSTRAINT "pedido_ticket_operativo_pedido_id_fkey"
  FOREIGN KEY ("pedido_id") REFERENCES "pedido"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
COMMENT ON TABLE "pedido_ticket_operativo" IS 'Ticket operativo (Pumping o FCR) del pedido y su paso actual, según los eventos de Operaciones.';
