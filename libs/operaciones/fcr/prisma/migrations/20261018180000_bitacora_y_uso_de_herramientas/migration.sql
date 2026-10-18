-- F4: acta de la reunión operativa, bitácora diaria (se envía a Facturación día por día), uso diario de las herramientas y revisión de
-- reportes. Specs de la demo: specs/fcr-bitacora-envio-diario y specs/ot-fcr (completación o trabajo y picker por herramienta y día).

CREATE TYPE "estado_uso_herramienta" AS ENUM ('operacion', 'stand_by', 'daily_charge', 'venta');

-- ---------------------------------------------------------------------------------------------------------------
-- Acta de la reunión operativa (una por ticket)
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE "reunion_operativa" (
    "ticket_id" UUID NOT NULL,
    "fecha" DATE NOT NULL,
    "firmada_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "firmada_por" UUID NOT NULL,
    CONSTRAINT "reunion_operativa_pkey" PRIMARY KEY ("ticket_id"),
    CONSTRAINT "reunion_operativa_ticket_fkey" FOREIGN KEY ("ticket_id") REFERENCES "ticket" ("id") ON DELETE CASCADE,
    CONSTRAINT "reunion_operativa_firmada_por_fkey" FOREIGN KEY ("firmada_por") REFERENCES identidad.usuario ("id")
);
COMMENT ON TABLE "reunion_operativa" IS 'Acta de la reunión operativa antes de la ejecución: fecha de la reunión y quién confirmó el acta (con la hora del servidor). El Supervisor puede corregir la fecha mientras el ticket siga en ese paso.';

-- ---------------------------------------------------------------------------------------------------------------
-- Bitácora diaria: una por día, con sus actividades. Se envía a Comercial (Reporte Job) día por día.
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE "bitacora_dia" (
    "id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "fecha" DATE NOT NULL,
    "enviada_at" TIMESTAMPTZ(6),
    "enviada_por" UUID,
    "corregida_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID NOT NULL,
    CONSTRAINT "bitacora_dia_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "bitacora_dia_ticket_fkey" FOREIGN KEY ("ticket_id") REFERENCES "ticket" ("id") ON DELETE CASCADE,
    CONSTRAINT "bitacora_dia_enviada_por_fkey" FOREIGN KEY ("enviada_por") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "bitacora_dia_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "bitacora_dia_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "bitacora_dia_enviada_check" CHECK (("enviada_at" IS NULL) = ("enviada_por" IS NULL))
);
CREATE UNIQUE INDEX "bitacora_dia_ticket_fecha_key" ON "bitacora_dia" ("ticket_id", "fecha");
COMMENT ON TABLE "bitacora_dia" IS 'Bitácora de actividades de un día del ticket (fuente del Reporte Job DYN-SGI-RE-047 de ese día). Se envía a Comercial por evento; reenviar reemplaza el documento (no duplica).';
COMMENT ON COLUMN "bitacora_dia"."corregida_at" IS 'Facturación corrigió este día en el pedido (evento de Comercial): el ticket ya no lo edita ni lo reenvía.';

-- las fechas de la bitácora van dentro de las del servicio del pedido (si el pedido las trae)
CREATE FUNCTION fcr.exigir_dia_del_servicio() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  inicio date;
  fin date;
BEGIN
  SELECT t.fecha_inicio_servicio, t.fecha_fin_servicio INTO inicio, fin FROM fcr.ticket t WHERE t.id = NEW.ticket_id;
  IF (inicio IS NOT NULL AND NEW.fecha < inicio) OR (fin IS NOT NULL AND NEW.fecha > fin) THEN
    RAISE EXCEPTION 'El día % está fuera de las fechas del servicio del pedido', NEW.fecha USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "bitacora_dia_servicio" BEFORE INSERT ON "bitacora_dia" FOR EACH ROW EXECUTE FUNCTION fcr.exigir_dia_del_servicio();

CREATE TABLE "bitacora_actividad" (
    "id" UUID NOT NULL,
    "bitacora_dia_id" UUID NOT NULL,
    "orden" INTEGER NOT NULL,
    "hora_inicio" TIME(0) NOT NULL,
    "hora_fin" TIME(0) NOT NULL,
    "detalle" TEXT NOT NULL,
    "autor_id" UUID NOT NULL,
    CONSTRAINT "bitacora_actividad_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "bitacora_actividad_dia_fkey" FOREIGN KEY ("bitacora_dia_id") REFERENCES "bitacora_dia" ("id") ON DELETE CASCADE,
    CONSTRAINT "bitacora_actividad_autor_fkey" FOREIGN KEY ("autor_id") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "bitacora_actividad_orden_check" CHECK ("orden" >= 0),
    CONSTRAINT "bitacora_actividad_horas_check" CHECK ("hora_inicio" <> "hora_fin"),
    CONSTRAINT "bitacora_actividad_detalle_check" CHECK (length(btrim("detalle")) > 0)
);
CREATE UNIQUE INDEX "bitacora_actividad_orden_key" ON "bitacora_actividad" ("bitacora_dia_id", "orden");
-- guardar un día reemplaza sus actividades
GRANT DELETE ON "bitacora_actividad" TO app_operaciones;
COMMENT ON COLUMN "bitacora_actividad"."autor_id" IS 'Cuenta de quien escribió la actividad (el operador o Facturación al corregir).';

-- ---------------------------------------------------------------------------------------------------------------
-- Uso diario de cada herramienta, con su registro de completación o trabajo y picker
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE "uso_herramienta_dia" (
    "id" UUID NOT NULL,
    "herramienta_id" UUID NOT NULL,
    "fecha" DATE NOT NULL,
    "estado" "estado_uso_herramienta" NOT NULL,
    "tipo_completacion_id" UUID,
    "tipo_trabajo_id" UUID,
    "tipo_picker_id" UUID,
    "presion" NUMERIC(10,2),
    "peso" NUMERIC(10,2),
    "observacion" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID NOT NULL,
    CONSTRAINT "uso_herramienta_dia_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "uso_herramienta_dia_herramienta_fkey" FOREIGN KEY ("herramienta_id") REFERENCES "ticket_herramienta" ("id") ON DELETE CASCADE,
    CONSTRAINT "uso_herramienta_dia_completacion_fkey" FOREIGN KEY ("tipo_completacion_id") REFERENCES "tipo_completacion" ("id"),
    CONSTRAINT "uso_herramienta_dia_trabajo_fkey" FOREIGN KEY ("tipo_trabajo_id") REFERENCES "tipo_trabajo" ("id"),
    CONSTRAINT "uso_herramienta_dia_picker_fkey" FOREIGN KEY ("tipo_picker_id") REFERENCES "tipo_picker" ("id"),
    CONSTRAINT "uso_herramienta_dia_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "uso_herramienta_dia_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id"),
    -- completación (venta) o trabajo (servicios), nunca las dos
    CONSTRAINT "uso_herramienta_dia_tipo_check" CHECK ("tipo_completacion_id" IS NULL OR "tipo_trabajo_id" IS NULL),
    CONSTRAINT "uso_herramienta_dia_medidas_check" CHECK (("presion" IS NULL OR "presion" >= 0) AND ("peso" IS NULL OR "peso" >= 0)),
    CONSTRAINT "uso_herramienta_dia_observacion_check" CHECK ("observacion" IS NULL OR length(btrim("observacion")) > 0)
);
CREATE UNIQUE INDEX "uso_herramienta_dia_key" ON "uso_herramienta_dia" ("herramienta_id", "fecha");
GRANT DELETE ON "uso_herramienta_dia" TO app_operaciones;
COMMENT ON TABLE "uso_herramienta_dia" IS 'Uso de una herramienta en un día: su estado de cobro (operación, stand by, daily charge o venta) y, si se registra, completación (venta) o tipo de trabajo (servicios), picker, presión, peso y observación. Registrar de nuevo el mismo día reemplaza la fila.';
COMMENT ON COLUMN "uso_herramienta_dia"."observacion" IS 'Solo si hubo alguna novedad durante el uso de la herramienta.';

-- el día de uso también va dentro de las fechas del servicio
CREATE FUNCTION fcr.exigir_uso_del_servicio() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  inicio date;
  fin date;
BEGIN
  SELECT t.fecha_inicio_servicio, t.fecha_fin_servicio INTO inicio, fin
    FROM fcr.ticket_herramienta h JOIN fcr.ticket t ON t.id = h.ticket_id WHERE h.id = NEW.herramienta_id;
  IF (inicio IS NOT NULL AND NEW.fecha < inicio) OR (fin IS NOT NULL AND NEW.fecha > fin) THEN
    RAISE EXCEPTION 'El día % está fuera de las fechas del servicio del pedido', NEW.fecha USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "uso_herramienta_dia_servicio" BEFORE INSERT OR UPDATE OF "fecha" ON "uso_herramienta_dia" FOR EACH ROW EXECUTE FUNCTION fcr.exigir_uso_del_servicio();

-- ---------------------------------------------------------------------------------------------------------------
-- Pasos de la ejecución que hacen acciones propias: finalizar la ejecución (envía el Reporte de Herramientas) y aprobar o rechazar los reportes
-- ---------------------------------------------------------------------------------------------------------------
UPDATE "transicion" SET "solo_por_accion" = true WHERE ("origen_codigo", "destino_codigo") IN (
  ('ejecucion_operativa', 'revision_reportes'), ('revision_reportes', 'control_retorno'), ('revision_reportes', 'ejecucion_operativa')
);
