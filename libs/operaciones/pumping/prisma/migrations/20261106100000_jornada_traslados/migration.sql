-- Jornadas (etapa 7c): cada día del servicio repite el traslado de salida y de llegada, así que lo que antes exigían los pasos de traslado
-- (una sola vez por ticket) pasa a ser requisito de cada jornada, por cada unidad de transporte.
--   Apertura del día: inspección realizada y aprobada, reporte de unidad de salida firmado, gerenciamiento de viaje de salida aprobado y sin SWA activa.
--   Cierre del día: reporte de unidad de llegada firmado y gerenciamiento de viaje de retorno aprobado.
-- La entrega de EPI y los términos del operador siguen siendo una vez por servicio.

-- los requisitos «por unidad» tienen una fila por cada unidad del ticket en cada jornada
ALTER TABLE "pumping"."requisito" ADD COLUMN "por_unidad" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "pumping"."requisito"
  ADD CONSTRAINT "requisito_por_unidad_check" CHECK (NOT "por_unidad" OR "ambito" = 'jornada');
COMMENT ON COLUMN "pumping"."requisito"."por_unidad" IS 'Solo en los requisitos de ámbito jornada: hay una fila por cada unidad del ticket en cada día.';

-- Lo que Flota hace por unidad y por día (llega por eventos, a veces antes de que existan las jornadas: el conductor inspecciona la unidad antes
-- de salir). Se guarda aquí y la jornada lo toma de aquí.
CREATE TYPE "pumping"."tipo_hecho_traslado" AS ENUM ('inspeccion_realizada', 'inspeccion_aprobada', 'gerenciamiento_salida', 'gerenciamiento_retorno');
CREATE TABLE "pumping"."ticket_hecho_traslado" (
    "id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    -- unidad de Flota (FK solo en la base de datos: es de otro esquema)
    "unidad_id" UUID NOT NULL,
    "fecha" DATE NOT NULL,
    "tipo" "pumping"."tipo_hecho_traslado" NOT NULL,
    -- falso cuando se anula la inspección o se rechaza lo aprobado
    "vigente" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ticket_hecho_traslado_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ticket_hecho_traslado_ticket_fkey" FOREIGN KEY ("ticket_id") REFERENCES "pumping"."ticket" ("id") ON DELETE CASCADE,
    CONSTRAINT "ticket_hecho_traslado_unidad_fkey" FOREIGN KEY ("unidad_id") REFERENCES "flota"."unidad" ("id")
);
CREATE UNIQUE INDEX "ticket_hecho_traslado_unico_key" ON "pumping"."ticket_hecho_traslado" ("ticket_id", "unidad_id", "fecha", "tipo");
CREATE INDEX "ticket_hecho_traslado_unidad_id_idx" ON "pumping"."ticket_hecho_traslado" ("unidad_id");
GRANT SELECT, INSERT, UPDATE ON "pumping"."ticket_hecho_traslado" TO app_operaciones;
REVOKE DELETE, TRUNCATE ON "pumping"."ticket_hecho_traslado" FROM app_operaciones;
COMMENT ON TABLE "pumping"."ticket_hecho_traslado" IS 'Hechos de Flota por unidad y día (inspección realizada y aprobada, gerenciamiento de viaje de salida y de retorno), que llegan por eventos y alimentan los requisitos de cada jornada.';

INSERT INTO "pumping"."requisito" ("codigo", "nombre", "descripcion", "ambito", "modulo", "activo", "momento", "por_unidad") VALUES
  ('inspeccion_vehiculo_dia', 'Inspección de vehículos del día realizada',
   'El conductor de la unidad realizó la Inspección de Vehículos (DYN-SGI-RE-068) de ese día desde Flota.',
   'jornada', 'flota', true, 'apertura', true),
  ('inspeccion_aprobada_dia', 'Inspección de vehículos del día aprobada',
   'El Supervisor aprobó la Inspección de Vehículos de la unidad de ese día.',
   'jornada', 'flota', true, 'apertura', true),
  ('reporte_unidad_salida_dia', 'Reporte de unidad de salida del día',
   'El operador firmó el Reporte de Unidad (DYN-MNT-RE-012) de salida de su unidad de ese día.',
   'jornada', 'pumping', true, 'apertura', true),
  ('gerenciamiento_salida_dia', 'Gerenciamiento de viaje de salida del día aprobado',
   'El Gerenciamiento de Viaje (DYN-SGI-RE-049) de salida de ese día que solicitó el Conductor de la unidad está aprobado.',
   'jornada', 'flota', true, 'apertura', true),
  ('sin_swa_dia', 'Sin Stop Work Authority activa',
   'Ninguna Stop Work Authority (SWA) activa en el servicio: una SWA activa bloquea el día hasta que QHSE la cierre con el checklist de reinicio completo.',
   'jornada', 'qhse', true, 'apertura', false),
  ('reporte_unidad_llegada_dia', 'Reporte de unidad de llegada del día',
   'El operador firmó el Reporte de Unidad (DYN-MNT-RE-012) de llegada de su unidad de ese día.',
   'jornada', 'pumping', true, 'cierre', true),
  ('gerenciamiento_retorno_dia', 'Gerenciamiento de viaje de retorno del día aprobado',
   'El Gerenciamiento de Viaje (DYN-SGI-RE-049) de retorno de ese día que solicitó el Conductor de la unidad está aprobado.',
   'jornada', 'flota', true, 'cierre', true);

-- los pasos de traslado ya no exigen lo que ahora exige cada jornada (los requisitos antiguos quedan definidos pero inactivos, por la historia)
DELETE FROM "pumping"."paso_requisito" WHERE "requisito_codigo" IN (
  'inspeccion_vehiculo_realizada', 'inspeccion_vehiculo_aprobada', 'reporte_unidad_salida',
  'gerenciamiento_viaje_salida_aprobado', 'gerenciamiento_viaje_retorno_aprobado', 'reporte_unidad_llegada');
UPDATE "pumping"."requisito" SET "activo" = false WHERE "codigo" IN (
  'inspeccion_vehiculo_realizada', 'inspeccion_vehiculo_aprobada', 'reporte_unidad_salida',
  'gerenciamiento_viaje_salida_aprobado', 'gerenciamiento_viaje_retorno_aprobado', 'reporte_unidad_llegada');
