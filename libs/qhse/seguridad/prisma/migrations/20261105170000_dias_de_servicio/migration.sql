-- PTW diario: Pumping avisa qué días tiene activos cada ticket (los pendientes, abiertos o cerrados; no los «sin operación» ni los que no aplican)
-- y una tarea programada abre el PTW de cada día en cuanto empieza. Esta tabla guarda esos días; cada aviso trae la lista completa y la reemplaza.
CREATE TABLE "ticket_dia_servicio" (
    "ticket_id" UUID NOT NULL,
    "fecha" DATE NOT NULL,
    CONSTRAINT "ticket_dia_servicio_pkey" PRIMARY KEY ("ticket_id", "fecha"),
    CONSTRAINT "ticket_dia_servicio_ticket_fkey" FOREIGN KEY ("ticket_id") REFERENCES "ticket_ref" ("ticket_id") ON DELETE CASCADE
);
CREATE INDEX "ticket_dia_servicio_fecha_idx" ON "ticket_dia_servicio" ("fecha");
GRANT DELETE ON "ticket_dia_servicio" TO app_qhse;
COMMENT ON TABLE "ticket_dia_servicio" IS 'Días de servicio activos de cada ticket de Pumping, recibidos por evento (operaciones.pumping.dias_de_servicio_actualizados). De aquí sale qué PTW abre la tarea programada cada día. Se reemplazan con cada aviso.';
