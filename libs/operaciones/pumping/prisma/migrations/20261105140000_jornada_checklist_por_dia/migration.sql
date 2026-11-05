-- Jornadas (etapa 3): el checklist de seguridad (confirmaciones, gases y LOTO) pasa de uno por ticket a uno por día. La lectura de gas del día
-- anterior no vale para hoy. Lo ya registrado se asigna al primer día del servicio (o al día en que se creó, si el ticket no tiene fechas).

-- 1) la fecha en las tres tablas, rellenada desde lo que ya existe
ALTER TABLE "pumping"."ticket_ingreso" ADD COLUMN "fecha" DATE;
UPDATE "pumping"."ticket_ingreso" i
   SET "fecha" = COALESCE(
     (SELECT t."fecha_inicio_servicio" FROM "pumping"."ticket" t WHERE t."id" = i."ticket_id"),
     (i."created_at" AT TIME ZONE 'America/Guayaquil')::date);
ALTER TABLE "pumping"."ticket_ingreso" ALTER COLUMN "fecha" SET NOT NULL;

ALTER TABLE "pumping"."ticket_ingreso_gas" ADD COLUMN "fecha" DATE;
UPDATE "pumping"."ticket_ingreso_gas" g SET "fecha" = i."fecha" FROM "pumping"."ticket_ingreso" i WHERE i."ticket_id" = g."ticket_id";
ALTER TABLE "pumping"."ticket_ingreso_gas" ALTER COLUMN "fecha" SET NOT NULL;

ALTER TABLE "pumping"."ticket_ingreso_loto" ADD COLUMN "fecha" DATE;
UPDATE "pumping"."ticket_ingreso_loto" l SET "fecha" = i."fecha" FROM "pumping"."ticket_ingreso" i WHERE i."ticket_id" = l."ticket_id";
ALTER TABLE "pumping"."ticket_ingreso_loto" ALTER COLUMN "fecha" SET NOT NULL;

-- 2) las claves: (ticket, fecha) en el checklist y las dos tablas que cuelgan de él
ALTER TABLE "pumping"."ticket_ingreso_gas" DROP CONSTRAINT "ticket_ingreso_gas_ticket_fkey";
ALTER TABLE "pumping"."ticket_ingreso_loto" DROP CONSTRAINT "ticket_ingreso_loto_ticket_fkey";
ALTER TABLE "pumping"."ticket_ingreso_loto" DROP CONSTRAINT "ticket_ingreso_loto_pkey";
ALTER TABLE "pumping"."ticket_ingreso" DROP CONSTRAINT "ticket_ingreso_pkey";
ALTER TABLE "pumping"."ticket_ingreso" ADD CONSTRAINT "ticket_ingreso_pkey" PRIMARY KEY ("ticket_id", "fecha");
ALTER TABLE "pumping"."ticket_ingreso_gas"
  ADD CONSTRAINT "ticket_ingreso_gas_ingreso_fkey" FOREIGN KEY ("ticket_id", "fecha") REFERENCES "pumping"."ticket_ingreso" ("ticket_id", "fecha") ON DELETE CASCADE;
ALTER TABLE "pumping"."ticket_ingreso_loto" ADD CONSTRAINT "ticket_ingreso_loto_pkey" PRIMARY KEY ("ticket_id", "fecha", "loto_item_id");
ALTER TABLE "pumping"."ticket_ingreso_loto"
  ADD CONSTRAINT "ticket_ingreso_loto_ingreso_fkey" FOREIGN KEY ("ticket_id", "fecha") REFERENCES "pumping"."ticket_ingreso" ("ticket_id", "fecha") ON DELETE CASCADE;
DROP INDEX "pumping"."ticket_ingreso_gas_ticket_gas_idx";
CREATE INDEX "ticket_ingreso_gas_ticket_gas_idx" ON "pumping"."ticket_ingreso_gas" ("ticket_id", "fecha", "gas", "medido_at");
COMMENT ON COLUMN "pumping"."ticket_ingreso"."fecha" IS 'Día de la jornada al que pertenece este checklist (uno por ticket y día): las lecturas de gas y el LOTO del día anterior no valen para hoy.';

-- 3) el requisito por día ya se exige: abrir la jornada pide el checklist de ese día completo
UPDATE "pumping"."requisito" SET "activo" = true WHERE "codigo" = 'checklist_seguridad_dia';
UPDATE "pumping"."requisito"
   SET "descripcion" = 'Algún día del servicio ya tiene su checklist de ingreso completo. Se retira cuando la salida de Ejecución operativa pase a depender de las jornadas: cada día exige el suyo (requisito checklist_seguridad_dia).'
 WHERE "codigo" = 'checklist_ingreso_locacion';
