-- Declaración del trabajador en la entrega de EPI: si el operador ya aceptó los términos y condiciones en Pumping, esa aceptación es su declaración
-- y QHSE no tiene que registrarla aparte. Pumping avisa cada aceptación por evento (operaciones.pumping.terminos_aceptados) y aquí se guarda.
-- Va aparte de ticket_operador: una reasignación reemplaza a los operadores, pero lo que el operador ya aceptó no se pierde.
CREATE TABLE "ticket_operador_terminos" (
    "ticket_id" UUID NOT NULL,
    "usuario_id" UUID NOT NULL,
    "version_codigo" TEXT NOT NULL,
    "aceptado_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "ticket_operador_terminos_pkey" PRIMARY KEY ("ticket_id", "usuario_id"),
    CONSTRAINT "ticket_operador_terminos_ticket_fkey" FOREIGN KEY ("ticket_id") REFERENCES "ticket_ref" ("ticket_id") ON DELETE CASCADE
);
GRANT DELETE ON "ticket_operador_terminos" TO app_qhse;
COMMENT ON TABLE "ticket_operador_terminos" IS 'Aceptación de los términos y condiciones que cada operador hizo en Pumping (evento operaciones.pumping.terminos_aceptados). Cuenta como su declaración en la entrega de EPI.';
