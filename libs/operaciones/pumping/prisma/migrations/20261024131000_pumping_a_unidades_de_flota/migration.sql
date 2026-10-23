-- D2: Pumping asigna unidades de Flota (flota.unidad) en vez de vehículos del catálogo (catalogos.vehiculo).
-- Pumping y Flota son del mismo contenedor (operaciones): la referencia es una FK real. El vehículo del catálogo sigue disponible a
-- través de la unidad (flota.unidad.vehiculo_id, único): de ahí sale la placa cuando la unidad tiene vehículo enlazado.
--
-- Orden: se agregan las columnas nuevas, se rellenan desde el vehículo de cada fila, se comprueba que nada quedó sin unidad (si falta
-- alguna, la migración se detiene y no cambia nada), se sueltan las llaves que dependían de `vehiculo_id`, se elimina la columna vieja y
-- se recrean las llaves sobre `unidad_id`.

-- 1. Columnas nuevas (nulas hasta rellenarlas)
ALTER TABLE "pumping"."ticket_unidad" ADD COLUMN "unidad_id" UUID;
ALTER TABLE "pumping"."ticket_persona" ADD COLUMN "unidad_id" UUID;
ALTER TABLE "pumping"."ticket_requisito" ADD COLUMN "unidad_id" UUID;
ALTER TABLE "pumping"."reporte_unidad" ADD COLUMN "unidad_id" UUID;

-- 2. Rellenar con la unidad de Flota enlazada al vehículo de cada fila (`flota.unidad.vehiculo_id` es único: no hay ambigüedad)
UPDATE "pumping"."ticket_unidad" t SET "unidad_id" = u."id" FROM flota.unidad u WHERE u."vehiculo_id" = t."vehiculo_id";
UPDATE "pumping"."ticket_persona" t SET "unidad_id" = u."id" FROM flota.unidad u WHERE t."vehiculo_id" IS NOT NULL AND u."vehiculo_id" = t."vehiculo_id";
UPDATE "pumping"."ticket_requisito" t SET "unidad_id" = u."id" FROM flota.unidad u WHERE t."vehiculo_id" IS NOT NULL AND u."vehiculo_id" = t."vehiculo_id";
UPDATE "pumping"."reporte_unidad" t SET "unidad_id" = u."id" FROM flota.unidad u WHERE u."vehiculo_id" = t."vehiculo_id";

-- 3. Nada se pierde: si algún vehículo en uso no tiene unidad en Flota, se detiene todo (la migración es atómica)
DO $$
DECLARE
  sin_unidad INTEGER;
BEGIN
  SELECT count(*) INTO sin_unidad FROM (
    SELECT "vehiculo_id" FROM "pumping"."ticket_unidad" WHERE "unidad_id" IS NULL
    UNION SELECT "vehiculo_id" FROM "pumping"."ticket_persona" WHERE "vehiculo_id" IS NOT NULL AND "unidad_id" IS NULL
    UNION SELECT "vehiculo_id" FROM "pumping"."ticket_requisito" WHERE "vehiculo_id" IS NOT NULL AND "unidad_id" IS NULL
    UNION SELECT "vehiculo_id" FROM "pumping"."reporte_unidad" WHERE "unidad_id" IS NULL
  ) v;
  IF sin_unidad > 0 THEN
    RAISE EXCEPTION 'D2: % vehículo(s) del catálogo en uso por Pumping no tienen unidad en Flota. Enlace cada vehículo a una unidad (flota.unidad.vehiculo_id) y vuelva a correr la migración.', sin_unidad;
  END IF;
END
$$;

-- 4. Soltar lo que dependía de `vehiculo_id` (primero las tablas hijas)
ALTER TABLE "pumping"."ticket_persona" DROP CONSTRAINT "ticket_persona_unidad_fkey";
DROP INDEX "pumping"."ticket_persona_vehiculo_id_idx";
ALTER TABLE "pumping"."ticket_requisito"
  DROP CONSTRAINT "ticket_requisito_unidad_fkey",
  DROP CONSTRAINT "ticket_requisito_vehiculo_fkey",
  DROP CONSTRAINT "ticket_requisito_ambito_check";
DROP INDEX "pumping"."ticket_requisito_unico_key";
ALTER TABLE "pumping"."reporte_unidad"
  DROP CONSTRAINT "reporte_unidad_unidad_fkey",
  DROP CONSTRAINT "reporte_unidad_vehiculo_fkey";
DROP INDEX "pumping"."reporte_unidad_ticket_vehiculo_key";
ALTER TABLE "pumping"."ticket_unidad"
  DROP CONSTRAINT "ticket_unidad_vehiculo_id_fkey",
  DROP CONSTRAINT "ticket_unidad_pkey";

-- 5. La columna vieja sale; la nueva es obligatoria donde la vieja lo era
ALTER TABLE "pumping"."ticket_unidad" DROP COLUMN "vehiculo_id", ALTER COLUMN "unidad_id" SET NOT NULL;
ALTER TABLE "pumping"."ticket_persona" DROP COLUMN "vehiculo_id";
ALTER TABLE "pumping"."ticket_requisito" DROP COLUMN "vehiculo_id";
ALTER TABLE "pumping"."reporte_unidad" DROP COLUMN "vehiculo_id", ALTER COLUMN "unidad_id" SET NOT NULL;

-- 6. Llaves sobre la unidad de Flota. `ticket_unidad` es la única con FK a `flota.unidad`; las demás se enlazan a ella con FK compuesta
--    (ticket + unidad): así una unidad solo aparece donde está asignada al ticket.
ALTER TABLE "pumping"."ticket_unidad"
  ADD CONSTRAINT "ticket_unidad_pkey" PRIMARY KEY ("ticket_id", "unidad_id"),
  ADD CONSTRAINT "ticket_unidad_unidad_id_fkey" FOREIGN KEY ("unidad_id") REFERENCES flota.unidad ("id");
CREATE INDEX "ticket_unidad_unidad_id_idx" ON "pumping"."ticket_unidad" ("unidad_id");

ALTER TABLE "pumping"."ticket_persona"
  ADD CONSTRAINT "ticket_persona_unidad_fkey" FOREIGN KEY ("ticket_id", "unidad_id") REFERENCES "pumping"."ticket_unidad" ("ticket_id", "unidad_id");
CREATE INDEX "ticket_persona_unidad_id_idx" ON "pumping"."ticket_persona" ("unidad_id");

ALTER TABLE "pumping"."ticket_requisito"
  ADD CONSTRAINT "ticket_requisito_unidad_fkey" FOREIGN KEY ("ticket_id", "unidad_id") REFERENCES "pumping"."ticket_unidad" ("ticket_id", "unidad_id"),
  ADD CONSTRAINT "ticket_requisito_ambito_check" CHECK ("unidad_id" IS NULL OR "usuario_id" IS NULL);
CREATE UNIQUE INDEX "ticket_requisito_unico_key" ON "pumping"."ticket_requisito" ("ticket_id", "requisito_codigo", "unidad_id", "usuario_id") NULLS NOT DISTINCT;

ALTER TABLE "pumping"."reporte_unidad"
  ADD CONSTRAINT "reporte_unidad_unidad_fkey" FOREIGN KEY ("ticket_id", "unidad_id") REFERENCES "pumping"."ticket_unidad" ("ticket_id", "unidad_id") ON DELETE CASCADE;
CREATE UNIQUE INDEX "reporte_unidad_ticket_unidad_key" ON "pumping"."reporte_unidad" ("ticket_id", "unidad_id");

COMMENT ON COLUMN "pumping"."ticket_unidad"."unidad_id" IS 'Unidad de Flota (flota.unidad, mismo contenedor: FK real) asignada al ticket. La placa, si la unidad tiene vehículo enlazado, sale de flota.unidad.vehiculo_id.';
COMMENT ON COLUMN "pumping"."ticket_persona"."unidad_id" IS 'Unidad que lleva este operador o conductor (FK compuesta a ticket_unidad).';
COMMENT ON COLUMN "pumping"."ticket_requisito"."unidad_id" IS 'Unidad a la que se refiere el requisito (ámbito unidad); nula en los de ticket y de operador.';
COMMENT ON COLUMN "pumping"."reporte_unidad"."unidad_id" IS 'Unidad de Flota del reporte (una por ticket y unidad).';
