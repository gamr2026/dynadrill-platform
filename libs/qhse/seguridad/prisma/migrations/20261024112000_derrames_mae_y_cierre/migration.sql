-- QHSE, tramo Q4: Derrames, notificación obligatoria al MAE y cierre (HSE-AMBIENTAL-002). La notificación es obligatoria cuando la ubicación o la
-- banda de volumen la exigen (p. ej. mayor, o cualquier volumen en cuerpo de agua). Si QHSE confirma un volumen real, manda la banda más grave
-- entre la reportada y la real. Un derrame que la exige no se cierra sin haberla registrado. Una notificación registrada no se cambia.

ALTER TABLE "derrame"
  ADD COLUMN "notificado_mae_at" TIMESTAMPTZ(6),
  ADD COLUMN "notificado_mae_por" UUID,
  ADD COLUMN "mae_referencia" TEXT,
  ADD COLUMN "cerrado_at" TIMESTAMPTZ(6),
  ADD COLUMN "cerrado_por" UUID,
  ADD CONSTRAINT "derrame_notificado_mae_por_fkey" FOREIGN KEY ("notificado_mae_por") REFERENCES identidad.usuario ("id"),
  ADD CONSTRAINT "derrame_cerrado_por_fkey" FOREIGN KEY ("cerrado_por") REFERENCES identidad.usuario ("id"),
  -- la notificación se registra completa (quién y cuándo); la referencia del oficio es opcional pero no puede quedar vacía
  ADD CONSTRAINT "derrame_notificacion_mae_check" CHECK (
    (("notificado_mae_at" IS NULL) = ("notificado_mae_por" IS NULL))
    AND ("notificado_mae_at" IS NOT NULL OR "mae_referencia" IS NULL)
    AND ("mae_referencia" IS NULL OR length(btrim("mae_referencia")) > 0)),
  -- cerrado trae quién y cuándo; los demás estados, nada
  ADD CONSTRAINT "derrame_cierre_check" CHECK (
    ("estado" = 'cerrado' AND "cerrado_at" IS NOT NULL AND "cerrado_por" IS NOT NULL AND "cerrado_at" >= "contenido_at")
    OR ("estado" <> 'cerrado' AND "cerrado_at" IS NULL AND "cerrado_por" IS NULL));

-- ¿Este derrame obliga a notificar al MAE? La ubicación, la banda reportada o la banda del volumen real (la que contiene ese volumen entre las
-- bandas activas) lo exigen. Es la misma regla que aplica el servicio.
CREATE FUNCTION "derrame_requiere_mae"(p_derrame UUID) RETURNS BOOLEAN LANGUAGE sql STABLE SET search_path = qhse, pg_catalog AS $$
  SELECT COALESCE(
    (SELECT u."exige_notificacion_mae" OR b."exige_notificacion_mae"
            OR COALESCE((SELECT r."exige_notificacion_mae" FROM "derrame_banda_volumen" r
                          WHERE r."activo" AND d."volumen_real_barriles" IS NOT NULL
                            AND d."volumen_real_barriles" >= r."desde_barriles"
                            AND (r."hasta_barriles" IS NULL OR d."volumen_real_barriles" < r."hasta_barriles")), false)
       FROM "derrame" d
       JOIN "derrame_ubicacion" u ON u."id" = d."ubicacion_id"
       JOIN "derrame_banda_volumen" b ON b."id" = d."banda_id"
      WHERE d."id" = p_derrame), false)
$$;

-- Ciclo: activo → contenido (todo el checklist) → cerrado (exige la notificación al MAE si el derrame la requiere). La notificación solo se
-- registra si el derrame la requiere y no se cambia una vez registrada.
CREATE OR REPLACE FUNCTION "derrame_validar"() RETURNS trigger LANGUAGE plpgsql SET search_path = qhse, pg_catalog AS $$
DECLARE
  v_faltan INTEGER;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."estado" <> 'activo' THEN
      RAISE EXCEPTION 'Un derrame nace activo' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."notificado_mae_at" IS NOT NULL AND (NEW."notificado_mae_at" IS DISTINCT FROM OLD."notificado_mae_at"
      OR NEW."notificado_mae_por" IS DISTINCT FROM OLD."notificado_mae_por" OR NEW."mae_referencia" IS DISTINCT FROM OLD."mae_referencia") THEN
    RAISE EXCEPTION 'La notificación al MAE ya está registrada y no se cambia' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."notificado_mae_at" IS NULL AND NEW."notificado_mae_at" IS NOT NULL AND NOT "derrame_requiere_mae"(NEW."id") THEN
    RAISE EXCEPTION 'Este derrame no requiere notificar al MAE' USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."estado" = OLD."estado" THEN RETURN NEW; END IF;
  IF OLD."estado" = 'activo' AND NEW."estado" = 'contenido' THEN
    SELECT count(*) INTO v_faltan FROM "derrame_checklist_item" i
     WHERE i."activo" AND NOT EXISTS (SELECT 1 FROM "derrame_checklist_confirmacion" c WHERE c."derrame_id" = NEW."id" AND c."item_id" = i."id");
    IF v_faltan > 0 THEN
      RAISE EXCEPTION 'Para marcar el derrame como contenido hay que confirmar todo el checklist de contención (faltan %)', v_faltan USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."estado" = 'contenido' AND NEW."estado" = 'cerrado' THEN
    IF "derrame_requiere_mae"(NEW."id") AND NEW."notificado_mae_at" IS NULL THEN
      RAISE EXCEPTION 'Para cerrar el derrame hay que registrar la notificación al MAE' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Cambio de estado no permitido: de % a %', OLD."estado", NEW."estado" USING ERRCODE = 'check_violation';
END
$$;

GRANT UPDATE ("notificado_mae_at", "notificado_mae_por", "mae_referencia", "cerrado_at", "cerrado_por") ON "derrame" TO app_qhse;

COMMENT ON COLUMN "derrame"."notificado_mae_at" IS 'Cuándo se notificó al Ministerio del Ambiente (MAE). Obligatoria para cerrar si derrame_requiere_mae(id). Una vez registrada no se cambia.';
COMMENT ON COLUMN "derrame"."mae_referencia" IS 'Número o referencia del oficio o reporte presentado al MAE (opcional).';
COMMENT ON FUNCTION "derrame_requiere_mae"(UUID) IS 'Verdadero si la ubicación, la banda reportada o la banda del volumen real exigen notificar al MAE (HSE-AMBIENTAL-002).';
