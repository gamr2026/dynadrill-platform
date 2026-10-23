-- QHSE, tramo Q4: Derrames, el desecho que genera un derrame en suelo (HSE-AMBIENTAL-001/002). El suelo contaminado es un desecho peligroso: el
-- desecho guarda su derrame de origen con una FK real (mismo esquema `qhse`). Un derrame genera, como máximo, un desecho, y solo si su ubicación
-- genera desecho (columna `genera_desecho`, no el nombre). Quién elige la característica CRETIB, el contenedor y los galones es el equipo HSE.
-- También: las bandas de volumen son configurables por el Gerente HSE; una banda no se borra (los derrames la referencian).

ALTER TABLE "desecho"
  ADD COLUMN "derrame_id" UUID,
  ADD CONSTRAINT "desecho_derrame_key" UNIQUE ("derrame_id"),
  ADD CONSTRAINT "desecho_derrame_fkey" FOREIGN KEY ("derrame_id") REFERENCES "derrame" ("id");

-- El derrame de origen debe ser de una ubicación que genera desecho, y el desecho que genera es peligroso. Solo se fija al crearlo.
CREATE FUNCTION "desecho_origen_validar"() RETURNS trigger LANGUAGE plpgsql SET search_path = qhse, pg_catalog AS $$
DECLARE
  v_genera BOOLEAN;
BEGIN
  IF NEW."derrame_id" IS NULL THEN RETURN NEW; END IF;
  SELECT u."genera_desecho" INTO v_genera FROM "derrame" d JOIN "derrame_ubicacion" u ON u."id" = d."ubicacion_id" WHERE d."id" = NEW."derrame_id";
  IF NOT COALESCE(v_genera, false) THEN
    RAISE EXCEPTION 'Solo un derrame en una ubicación que genera desecho (p. ej. suelo) puede originar un desecho' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."clasificacion" <> 'peligroso' THEN
    RAISE EXCEPTION 'El desecho que genera un derrame es peligroso' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "desecho_origen_validar_trg" BEFORE INSERT ON "desecho" FOR EACH ROW EXECUTE FUNCTION "desecho_origen_validar"();

-- Catálogos de derrames: se configuran, no se borran.
REVOKE DELETE ON "derrame_banda_volumen" FROM app_qhse;
REVOKE DELETE ON "derrame_ubicacion" FROM app_qhse;

COMMENT ON COLUMN "desecho"."derrame_id" IS 'Derrame de origen (FK real, mismo esquema): el suelo contaminado por un derrame genera este desecho peligroso. Uno por derrame; solo se fija al crear.';
