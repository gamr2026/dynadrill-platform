-- QHSE, investigación de incidentes, rebanada 5: conclusión, notificación legal, lección aprendida, revisión y cierre. Ciclo completo:
-- abierta → en_investigacion → en_revision → cerrada (y en_revision → en_investigacion si el Gerente HSE la devuelve). Una investigación cerrada queda
-- congelada, con todo lo que la sostiene (secciones, causas): solo sigue el seguimiento de sus acciones.

CREATE TYPE "conclusion_investigacion" AS ENUM ('incidente', 'accidente');

ALTER TABLE "investigacion"
    ADD COLUMN "conclusion" "conclusion_investigacion",
    ADD COLUMN "lecciones_aprendidas" TEXT,
    ADD COLUMN "iperc_actividad_id" UUID,
    ADD COLUMN "notificacion_legal_requerida" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "ministerio_trabajo_notificado_at" TIMESTAMPTZ(6),
    ADD COLUMN "iess_notificado_at" TIMESTAMPTZ(6),
    ADD COLUMN "revision_enviada_at" TIMESTAMPTZ(6),
    ADD COLUMN "revision_enviada_por" UUID,
    ADD COLUMN "cerrada_at" TIMESTAMPTZ(6),
    ADD COLUMN "cerrada_por" UUID;

ALTER TABLE "investigacion"
    ADD CONSTRAINT "investigacion_iperc_actividad_fkey" FOREIGN KEY ("iperc_actividad_id") REFERENCES "iperc_actividad" ("id"),
    ADD CONSTRAINT "investigacion_revision_enviada_por_fkey" FOREIGN KEY ("revision_enviada_por") REFERENCES identidad.usuario ("id"),
    ADD CONSTRAINT "investigacion_cerrada_por_fkey" FOREIGN KEY ("cerrada_por") REFERENCES identidad.usuario ("id"),
    -- las fechas de notificación solo existen si la notificación legal es obligatoria
    ADD CONSTRAINT "investigacion_notificacion_check" CHECK (
      "notificacion_legal_requerida" OR ("ministerio_trabajo_notificado_at" IS NULL AND "iess_notificado_at" IS NULL));

COMMENT ON COLUMN "investigacion"."conclusion" IS 'Conclusión del formato: incidente (finaliza la investigación, sigue el plan de acción) o accidente (continúa el reporte al IESS). Obligatoria para enviar a revisión.';
COMMENT ON COLUMN "investigacion"."iperc_actividad_id" IS 'Actividad de la matriz IPERC a la que aplica la lección aprendida. Solo el vínculo: no cambia el estado de la matriz (consulta 24 a Dynadrill).';
COMMENT ON COLUMN "investigacion"."notificacion_legal_requerida" IS 'Si corresponde notificar a Ministerio del Trabajo e IESS (24 h; la sugiere el resultado del incidente). Si es obligatoria, el cierre exige ambas fechas.';
COMMENT ON COLUMN "investigacion"."cerrada_por" IS 'Quien aprobó el informe y cerró la investigación (Gerente HSE).';

-- Cada estado trae sus datos (reemplaza el CHECK de la rebanada 1)
ALTER TABLE "investigacion" DROP CONSTRAINT "investigacion_estado_check";
ALTER TABLE "investigacion" ADD CONSTRAINT "investigacion_estado_check" CHECK (
      ("estado" = 'abierta'
        AND "lider_id" IS NULL AND "escena_asegurada_at" IS NULL
        AND "revision_enviada_at" IS NULL AND "revision_enviada_por" IS NULL AND "cerrada_at" IS NULL AND "cerrada_por" IS NULL)
      OR ("estado" = 'en_investigacion'
        AND "lider_id" IS NOT NULL AND "escena_asegurada_at" IS NOT NULL
        AND "revision_enviada_at" IS NULL AND "revision_enviada_por" IS NULL AND "cerrada_at" IS NULL AND "cerrada_por" IS NULL)
      OR ("estado" = 'en_revision'
        AND "lider_id" IS NOT NULL AND "escena_asegurada_at" IS NOT NULL
        AND "revision_enviada_at" IS NOT NULL AND "revision_enviada_por" IS NOT NULL AND "cerrada_at" IS NULL AND "cerrada_por" IS NULL)
      OR ("estado" = 'cerrada'
        AND "lider_id" IS NOT NULL AND "escena_asegurada_at" IS NOT NULL
        AND "revision_enviada_at" IS NOT NULL AND "revision_enviada_por" IS NOT NULL
        AND "cerrada_at" IS NOT NULL AND "cerrada_por" IS NOT NULL AND "conclusion" IS NOT NULL));

-- Reglas del ciclo (reemplaza la función de la rebanada 2)
CREATE OR REPLACE FUNCTION "investigacion_validar"() RETURNS trigger LANGUAGE plpgsql SET search_path = qhse, pg_catalog AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."estado" <> 'abierta' THEN RAISE EXCEPTION 'Una investigación nace abierta' USING ERRCODE = 'check_violation'; END IF;
    RETURN NEW;
  END IF;
  IF OLD."estado" = 'cerrada' THEN
    RAISE EXCEPTION 'La investigación está cerrada y no admite cambios' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."resultado_id" <> OLD."resultado_id" OR NEW."fecha_incidente" <> OLD."fecha_incidente"
     OR NEW."descripcion_evento" <> OLD."descripcion_evento" OR NEW."ubicacion" <> OLD."ubicacion"
     OR NEW."origen_emergencia_id" IS DISTINCT FROM OLD."origen_emergencia_id" THEN
    RAISE EXCEPTION 'El resultado, la fecha, la descripción, la ubicación y el origen del incidente no se cambian' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."evidencias_recopiladas" IS DISTINCT FROM OLD."evidencias_recopiladas" OR NEW."testimonios_resumen" IS DISTINCT FROM OLD."testimonios_resumen"
      OR NEW."conclusion" IS DISTINCT FROM OLD."conclusion" OR NEW."lecciones_aprendidas" IS DISTINCT FROM OLD."lecciones_aprendidas"
      OR NEW."iperc_actividad_id" IS DISTINCT FROM OLD."iperc_actividad_id"
      OR NEW."notificacion_legal_requerida" IS DISTINCT FROM OLD."notificacion_legal_requerida"
      OR NEW."ministerio_trabajo_notificado_at" IS DISTINCT FROM OLD."ministerio_trabajo_notificado_at"
      OR NEW."iess_notificado_at" IS DISTINCT FROM OLD."iess_notificado_at")
     AND OLD."estado" NOT IN ('abierta', 'en_investigacion') THEN
    RAISE EXCEPTION 'La investigación ya no admite cambios' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."estado" = OLD."estado" THEN RETURN NEW; END IF;
  IF OLD."estado" = 'abierta' AND NEW."estado" = 'en_investigacion' THEN RETURN NEW; END IF;
  IF OLD."estado" = 'en_investigacion' AND NEW."estado" = 'en_revision' THEN
    IF (SELECT count(*) FROM "investigacion_porque" WHERE "investigacion_id" = NEW."id") < 5 THEN
      RAISE EXCEPTION 'Para enviar a revisión se necesitan al menos 5 niveles de los 5 Porqués' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."conclusion" IS NULL THEN
      RAISE EXCEPTION 'Para enviar a revisión se necesita la conclusión (incidente o accidente)' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "investigacion_accion" WHERE "investigacion_id" = NEW."id" AND "estado" <> 'cancelada') THEN
      RAISE EXCEPTION 'Para enviar a revisión se necesita al menos una acción correctiva o preventiva' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."estado" = 'en_revision' AND NEW."estado" = 'en_investigacion' THEN RETURN NEW; END IF;
  IF OLD."estado" = 'en_revision' AND NEW."estado" = 'cerrada' THEN
    IF NEW."notificacion_legal_requerida" AND (NEW."ministerio_trabajo_notificado_at" IS NULL OR NEW."iess_notificado_at" IS NULL) THEN
      RAISE EXCEPTION 'La notificación legal es obligatoria: registre la fecha de Ministerio del Trabajo y del IESS antes de cerrar' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Cambio de estado no permitido: de % a %', OLD."estado", NEW."estado" USING ERRCODE = 'check_violation';
END
$$;

-- Privilegios: además de lo anterior, la aplicación completa la conclusión, la lección, la notificación legal y los datos de revisión y cierre.
GRANT UPDATE ("conclusion", "lecciones_aprendidas", "iperc_actividad_id", "notificacion_legal_requerida", "ministerio_trabajo_notificado_at",
              "iess_notificado_at", "revision_enviada_at", "revision_enviada_por", "cerrada_at", "cerrada_por") ON "investigacion" TO app_qhse;
