-- Requisitos con plazo, vencimiento, exoneración e historia.
--   * Catálogo: `plazo_horas` (tolerancia después del fin del día de servicio; vacío = sin plazo) y `rol_responsable` (quién debe cumplirlo).
--   * Requisito del ticket: `vence_at`, `vencido_at` (cuándo se detectó el vencimiento; se conserva al cumplirse: «cumplido tarde») y la exoneración.
--   * Historia: `ticket_requisito_historial`, que llena un disparador de la base de datos para que ningún servicio pueda olvidarse de anotar.

-- ---------------------------------------------------------------------------------------------------------------
-- Catálogo
-- ---------------------------------------------------------------------------------------------------------------
ALTER TABLE "pumping"."requisito"
  ADD COLUMN "plazo_horas" INTEGER,
  ADD COLUMN "rol_responsable" TEXT,
  ADD CONSTRAINT "requisito_plazo_horas_check" CHECK ("plazo_horas" IS NULL OR "plazo_horas" >= 0),
  ADD CONSTRAINT "requisito_rol_responsable_check" CHECK ("rol_responsable" IS NULL OR length(btrim("rol_responsable")) > 0);
COMMENT ON COLUMN "pumping"."requisito"."plazo_horas" IS 'Horas de tolerancia después del ancla (el fin del día de servicio, en hora de Ecuador, en los requisitos de jornada). Vacío: sin plazo, nunca vence.';
COMMENT ON COLUMN "pumping"."requisito"."rol_responsable" IS 'Código del rol de identidad de quien debe cumplirlo (el mismo que tiene en la asignación del ticket). Vacío: no es unívoco (p. ej. lo cumple QHSE o Flota).';

-- los requisitos por día vencen al terminar el día de servicio (tolerancia 0)
UPDATE "pumping"."requisito" SET "plazo_horas" = 0 WHERE "ambito" = 'jornada';

-- responsable: solo donde el código o el catálogo lo dicen sin ambigüedad (lo de QHSE y lo de Flota queda vacío)
UPDATE "pumping"."requisito" SET "rol_responsable" = 'supervisor'
 WHERE "codigo" IN ('company_man_acepto_dia', 'ejecucion_formalizada');
UPDATE "pumping"."requisito" SET "rol_responsable" = 'operador'
 WHERE "codigo" IN ('checklist_seguridad_dia', 'job_log_dia', 'herramientas_dia', 'reporte_unidad_salida_dia', 'reporte_unidad_llegada_dia',
                    'checklist_ingreso_locacion', 'terminos_aceptados', 'reporte_herramientas_completado', 'reporte_unidad_salida', 'reporte_unidad_llegada');
UPDATE "pumping"."requisito" SET "rol_responsable" = 'conductor'
 WHERE "codigo" IN ('inspeccion_vehiculo_dia', 'inspeccion_vehiculo_realizada');

-- ---------------------------------------------------------------------------------------------------------------
-- Requisito del ticket
-- ---------------------------------------------------------------------------------------------------------------
ALTER TABLE "pumping"."ticket_requisito"
  ADD COLUMN "vence_at" TIMESTAMPTZ(6),
  ADD COLUMN "vencido_at" TIMESTAMPTZ(6),
  ADD COLUMN "exonerado_at" TIMESTAMPTZ(6),
  ADD COLUMN "exonerado_por" UUID,
  ADD CONSTRAINT "ticket_requisito_exonerado_por_fkey" FOREIGN KEY ("exonerado_por") REFERENCES identidad.usuario ("id"),
  -- exonerado si y solo si tiene la hora de la exoneración; y siempre con motivo
  ADD CONSTRAINT "ticket_requisito_exonerado_check" CHECK (("estado" = 'exonerado') = ("exonerado_at" IS NOT NULL)),
  ADD CONSTRAINT "ticket_requisito_exonerado_motivo_check" CHECK ("exonerado_at" IS NULL OR length(btrim(coalesce("motivo", ''))) > 0),
  ADD CONSTRAINT "ticket_requisito_exonerado_por_check" CHECK ("exonerado_por" IS NULL OR "exonerado_at" IS NOT NULL);
COMMENT ON COLUMN "pumping"."ticket_requisito"."vence_at" IS 'Cuándo vence: fin del día de servicio en hora de Ecuador más el plazo del catálogo. Vacío: sin plazo.';
COMMENT ON COLUMN "pumping"."ticket_requisito"."vencido_at" IS 'Cuándo la revisión periódica detectó que seguía pendiente pasado su plazo. Se conserva al cumplirse (queda como «cumplido tarde»).';
COMMENT ON COLUMN "pumping"."ticket_requisito"."exonerado_at" IS 'Cuándo se exoneró (estado exonerado): ya no bloquea ni lo recalcula la sincronización. Siempre con motivo.';
COMMENT ON COLUMN "pumping"."ticket_requisito"."exonerado_por" IS 'Quién lo exoneró (FK a identidad.usuario).';

-- fin del día de servicio (medianoche de Ecuador del día siguiente) más el plazo, en los requisitos por día que siguen pendientes
UPDATE "pumping"."ticket_requisito" r
   SET "vence_at" = (((r."fecha" + 1)::timestamp AT TIME ZONE 'America/Guayaquil') + q."plazo_horas" * interval '1 hour')
  FROM "pumping"."requisito" q
 WHERE q."codigo" = r."requisito_codigo" AND r."fecha" IS NOT NULL AND r."estado" = 'pendiente' AND q."plazo_horas" IS NOT NULL;

-- la revisión de vencidos recorre solo lo pendiente, con plazo y todavía sin marcar
CREATE INDEX "ticket_requisito_por_vencer_idx" ON "pumping"."ticket_requisito" ("vence_at")
  WHERE "estado" = 'pendiente' AND "vencido_at" IS NULL AND "vence_at" IS NOT NULL;

-- ---------------------------------------------------------------------------------------------------------------
-- Historia (solo se agrega)
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE "pumping"."ticket_requisito_historial" (
    "id" UUID NOT NULL,
    "ticket_requisito_id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    -- vacío en la primera fila (el requisito nace)
    "estado_anterior" "pumping"."estado_requisito",
    "estado_nuevo" "pumping"."estado_requisito" NOT NULL,
    -- ya estaba vencido (pasado su plazo y detectado) al anotarse este cambio
    "vencido" BOOLEAN NOT NULL DEFAULT false,
    "origen" TEXT NOT NULL,
    -- quién lo hizo (FK a identidad.usuario); vacío cuando lo hizo el sistema
    "actor_id" UUID,
    "motivo" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ticket_requisito_historial_pkey" PRIMARY KEY ("id"),
    -- la historia se va con el requisito o el ticket que la origina (como la bitácora de la jornada); la aplicación no puede borrarla
    CONSTRAINT "ticket_requisito_historial_requisito_fkey" FOREIGN KEY ("ticket_requisito_id") REFERENCES "pumping"."ticket_requisito" ("id") ON DELETE CASCADE,
    CONSTRAINT "ticket_requisito_historial_ticket_fkey" FOREIGN KEY ("ticket_id") REFERENCES "pumping"."ticket" ("id") ON DELETE CASCADE,
    CONSTRAINT "ticket_requisito_historial_actor_fkey" FOREIGN KEY ("actor_id") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "ticket_requisito_historial_origen_check" CHECK ("origen" IN
      ('creacion', 'sistema', 'evento', 'manual_temporal', 'reapertura', 'vencimiento', 'exoneracion', 'reversion_exoneracion', 'migracion'))
);
CREATE INDEX "ticket_requisito_historial_requisito_idx" ON "pumping"."ticket_requisito_historial" ("ticket_requisito_id", "created_at");
CREATE INDEX "ticket_requisito_historial_ticket_idx" ON "pumping"."ticket_requisito_historial" ("ticket_id");
GRANT SELECT, INSERT ON "pumping"."ticket_requisito_historial" TO app_operaciones;
REVOKE UPDATE, DELETE, TRUNCATE ON "pumping"."ticket_requisito_historial" FROM app_operaciones;
COMMENT ON TABLE "pumping"."ticket_requisito_historial" IS 'Cada cambio de estado o de vencimiento de un requisito del ticket, con su origen y quién lo hizo. La llena un disparador de ticket_requisito; la aplicación solo lee.';
COMMENT ON COLUMN "pumping"."ticket_requisito_historial"."origen" IS 'creacion, sistema, evento o manual_temporal (cómo se cumplió), reapertura, vencimiento, exoneracion, reversion_exoneracion o migracion (fila base de los requisitos anteriores a esta tabla).';

-- Disparador: anota cada alta y cada cambio de estado o de vencimiento. Los ids del proyecto son UUIDv7 generados por la aplicación y sin valor por
-- defecto en la base; aquí la fila la crea la base y no puede pedirlos a la aplicación, así que usa gen_random_uuid() (UUIDv4). Quien revierte una
-- exoneración o reabre un requisito (la fila no guarda quién) deja el actor y el motivo en la transacción con set_config('pumping.actor_id' / 'pumping.motivo', ..., true).
CREATE FUNCTION "pumping"."anotar_historial_requisito"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_actor  uuid;
  v_motivo text;
  v_origen text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_origen := CASE NEW."estado" WHEN 'cumplido' THEN coalesce(NEW."origen"::text, 'sistema') WHEN 'exonerado' THEN 'exoneracion' ELSE 'creacion' END;
    v_actor  := CASE NEW."estado" WHEN 'cumplido' THEN NEW."cumplido_por" WHEN 'exonerado' THEN NEW."exonerado_por" END;
    v_motivo := NEW."motivo";
    INSERT INTO "pumping"."ticket_requisito_historial" ("id", "ticket_requisito_id", "ticket_id", "estado_anterior", "estado_nuevo", "vencido", "origen", "actor_id", "motivo")
    VALUES (gen_random_uuid(), NEW."id", NEW."ticket_id", NULL, NEW."estado", NEW."vencido_at" IS NOT NULL, v_origen, v_actor, v_motivo);
    RETURN NEW;
  END IF;

  IF NEW."estado" IS NOT DISTINCT FROM OLD."estado" THEN
    -- solo cambió el vencimiento: lo detectó la revisión periódica
    v_origen := 'vencimiento';
    v_actor  := NULL;
    v_motivo := NULL;
  ELSIF NEW."estado" = 'exonerado' THEN
    v_origen := 'exoneracion';
    v_actor  := NEW."exonerado_por";
    v_motivo := NEW."motivo";
  ELSIF OLD."estado" = 'exonerado' THEN
    v_origen := 'reversion_exoneracion';
    v_actor  := nullif(current_setting('pumping.actor_id', true), '')::uuid;
    v_motivo := nullif(current_setting('pumping.motivo', true), '');
  ELSIF NEW."estado" = 'cumplido' THEN
    v_origen := coalesce(NEW."origen"::text, 'sistema');
    v_actor  := NEW."cumplido_por";
    v_motivo := NEW."motivo";
  ELSE
    v_origen := 'reapertura';
    v_actor  := nullif(current_setting('pumping.actor_id', true), '')::uuid;
    v_motivo := nullif(current_setting('pumping.motivo', true), '');
  END IF;
  INSERT INTO "pumping"."ticket_requisito_historial" ("id", "ticket_requisito_id", "ticket_id", "estado_anterior", "estado_nuevo", "vencido", "origen", "actor_id", "motivo")
  VALUES (gen_random_uuid(), NEW."id", NEW."ticket_id", OLD."estado", NEW."estado", NEW."vencido_at" IS NOT NULL, v_origen, v_actor, v_motivo);
  RETURN NEW;
END $$;
CREATE TRIGGER "ticket_requisito_historial_alta" AFTER INSERT ON "pumping"."ticket_requisito"
  FOR EACH ROW EXECUTE FUNCTION "pumping"."anotar_historial_requisito"();
CREATE TRIGGER "ticket_requisito_historial_cambio" AFTER UPDATE ON "pumping"."ticket_requisito"
  FOR EACH ROW WHEN (OLD."estado" IS DISTINCT FROM NEW."estado" OR OLD."vencido_at" IS DISTINCT FROM NEW."vencido_at")
  EXECUTE FUNCTION "pumping"."anotar_historial_requisito"();

-- fila base de lo que ya existía, para que la historia de cada requisito empiece en algún lado
INSERT INTO "pumping"."ticket_requisito_historial" ("id", "ticket_requisito_id", "ticket_id", "estado_anterior", "estado_nuevo", "vencido", "origen", "actor_id", "motivo", "created_at")
SELECT gen_random_uuid(), r."id", r."ticket_id", NULL, r."estado", false, 'migracion', r."cumplido_por", r."motivo", coalesce(r."cumplido_at", r."created_at")
  FROM "pumping"."ticket_requisito" r;
