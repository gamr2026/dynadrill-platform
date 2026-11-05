-- Jornadas (etapa 2): requisitos por día. Un requisito de ámbito `jornada` se crea por cada día activo del servicio (con su fecha) y
-- bloquea abrir o cerrar ese día. Se hace en dos migraciones porque un valor nuevo de enum no se puede usar en la misma transacción
-- en que se agrega: aquí va la estructura y en la siguiente el catálogo.

ALTER TYPE "pumping"."ambito_requisito" ADD VALUE IF NOT EXISTS 'jornada';
CREATE TYPE "pumping"."momento_requisito" AS ENUM ('apertura', 'cierre');

-- cuándo pesa un requisito de jornada: para abrir el día (PTW, checklist, aceptación del Company Man) o para cerrarlo (job log, herramientas)
ALTER TABLE "pumping"."requisito" ADD COLUMN "momento" "pumping"."momento_requisito";
COMMENT ON COLUMN "pumping"."requisito"."momento" IS 'Solo en los requisitos de ámbito jornada: `apertura` bloquea abrir el día; `cierre`, cerrarlo.';

-- la fecha del requisito de jornada (vacía en los de ticket, unidad u operador); apunta a la jornada de ese día
ALTER TABLE "pumping"."ticket_requisito" ADD COLUMN "fecha" DATE;
DROP INDEX "pumping"."ticket_requisito_unico_key";
CREATE UNIQUE INDEX "ticket_requisito_unico_key" ON "pumping"."ticket_requisito" ("ticket_id", "requisito_codigo", "unidad_id", "usuario_id", "fecha") NULLS NOT DISTINCT;
ALTER TABLE "pumping"."ticket_requisito"
  ADD CONSTRAINT "ticket_requisito_jornada_fkey" FOREIGN KEY ("ticket_id", "fecha") REFERENCES "pumping"."ticket_jornada" ("ticket_id", "fecha") ON DELETE CASCADE;
CREATE INDEX "ticket_requisito_ticket_fecha_idx" ON "pumping"."ticket_requisito" ("ticket_id", "fecha") WHERE "fecha" IS NOT NULL;
COMMENT ON COLUMN "pumping"."ticket_requisito"."fecha" IS 'Día de la jornada a la que pertenece (solo requisitos de ámbito jornada). El FK compuesto no se aplica cuando está vacía.';

-- la bitácora de la jornada también registra lo que hace el sistema (p. ej. abrir el día al cumplirse el último requisito): sin persona
ALTER TABLE "pumping"."ticket_jornada_historial" ALTER COLUMN "actor_id" DROP NOT NULL;
COMMENT ON COLUMN "pumping"."ticket_jornada_historial"."actor_id" IS 'Quién lo hizo; vacío cuando lo hizo el sistema.';
