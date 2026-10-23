-- Integración de S1 (emergencias) y S2 (investigaciones): ambas tablas viven en el mismo contenedor (esquema qhse),
-- así que la referencia pasa a ser una FK real. ON DELETE RESTRICT: una emergencia con investigación no se borra.
ALTER TABLE "investigacion"
  ADD CONSTRAINT "investigacion_origen_emergencia_fkey"
  FOREIGN KEY ("origen_emergencia_id") REFERENCES "emergencia" ("id") ON DELETE RESTRICT;

COMMENT ON COLUMN "investigacion"."origen_emergencia_id" IS 'Emergencia (Nivel 2/3) que originó la investigación. FK a emergencia (mismo esquema).';
