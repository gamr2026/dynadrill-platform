-- La función de reglas de la revisión usaba nombres de tabla sin esquema y fallaba con otro `search_path` (el de la aplicación y el de
-- quien inserta directo no son el mismo). Se reemplaza por una versión con esquema explícito y `search_path` fijo.
CREATE OR REPLACE FUNCTION flota."inspeccion_vehiculo_revision_reglas"() RETURNS trigger LANGUAGE plpgsql SET search_path = flota AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM flota."inspeccion_vehiculo" i WHERE i."id" = NEW."inspeccion_id" AND i."anulada_at" IS NOT NULL) THEN
    RAISE EXCEPTION 'No se puede revisar una inspección anulada' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."decision" = 'aprobada' AND EXISTS (
       SELECT 1
         FROM flota."inspeccion_vehiculo_resultado" r
         JOIN flota."item_inspeccion_vehiculo" it ON it."id" = r."item_id"
        WHERE r."inspeccion_id" = NEW."inspeccion_id" AND r."resultado" = 'no_cumple' AND it."bloquea_si_no_cumple"
     ) THEN
    RAISE EXCEPTION 'Un ítem que impide usar el vehículo (Nota 1) está en No cumple: la inspección no se puede aprobar'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
