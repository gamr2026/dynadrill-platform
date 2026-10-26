-- OP-1 (PARIDAD-MODELO-DEMO.md): Pumping genera el Reporte de Herramientas como FCR, pero sin selección de herramientas ni inspecciones:
-- parte de las líneas cotizadas del pedido y solo se reparte cada una por día. Como aquí no hay series ni filas añadidas a mano, la fila del
-- reporte ES la línea cotizada: no se duplica código, descripción ni unidad (en FCR se copian porque la fila puede existir sin línea).

-- 1) Líneas cotizadas del pedido. Son de `comercial` (otro contenedor, D1): se copian porque no se pueden consultar con JOIN. Se actualizan
--    por código cuando el pedido cambia (evento comercial.pedido.actualizado): una línea con días reportados no se borra.
CREATE TABLE "ticket_linea" (
    "id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "orden" SMALLINT NOT NULL,
    "lista_precios_item_id" UUID,
    "codigo" TEXT NOT NULL,
    "descripcion" TEXT NOT NULL,
    "unidad_medida_id" UUID NOT NULL,
    "cantidad" NUMERIC(12,3) NOT NULL,
    "tipo_linea" "tipo_linea_item" NOT NULL,
    CONSTRAINT "ticket_linea_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ticket_linea_ticket_fkey" FOREIGN KEY ("ticket_id") REFERENCES "ticket" ("id") ON DELETE CASCADE,
    CONSTRAINT "ticket_linea_unidad_medida_id_fkey" FOREIGN KEY ("unidad_medida_id") REFERENCES catalogos.unidad_medida ("id"),
    CONSTRAINT "ticket_linea_cantidad_check" CHECK ("cantidad" > 0),
    CONSTRAINT "ticket_linea_textos_check" CHECK (length(btrim("codigo")) > 0 AND length(btrim("descripcion")) > 0)
);
CREATE UNIQUE INDEX "ticket_linea_orden_key" ON "ticket_linea" ("ticket_id", "orden");
CREATE UNIQUE INDEX "ticket_linea_codigo_key" ON "ticket_linea" ("ticket_id", "codigo");
CREATE INDEX "ticket_linea_unidad_medida_id_idx" ON "ticket_linea" ("unidad_medida_id");
GRANT DELETE ON "ticket_linea" TO app_operaciones;
COMMENT ON TABLE "ticket_linea" IS 'Líneas cotizadas del pedido (código de la lista de precios, descripción, unidad, cantidad y tipo). Son de `comercial` (otro contenedor, D1): se copian porque no se pueden consultar con JOIN. De ellas sale el Reporte de Herramientas.';
COMMENT ON COLUMN "ticket_linea"."lista_precios_item_id" IS 'Ítem de la lista de precios del cliente en `comercial` (otro contenedor, D1): uuid sin FK; vacío si el ítem vino de AS2 sin enlace.';
COMMENT ON COLUMN "ticket_linea"."unidad_medida_id" IS 'Unidad de la línea (catálogo compartido). Su período decide si se reporta con marcas por día.';

-- 2) Cuándo se precargó el reporte (una sola vez) y cuándo se completó
CREATE TYPE "estado_item_reporte" AS ENUM ('operacion', 'daily_charge', 'venta');

ALTER TABLE "ticket"
  ADD COLUMN "reporte_precargado_at" TIMESTAMPTZ(6),
  ADD COLUMN "reporte_herramientas_completado_at" TIMESTAMPTZ(6),
  ADD COLUMN "reporte_herramientas_completado_por" UUID,
  ADD CONSTRAINT "ticket_reporte_herramientas_completado_por_fkey" FOREIGN KEY ("reporte_herramientas_completado_por") REFERENCES identidad.usuario ("id"),
  ADD CONSTRAINT "ticket_reporte_herramientas_completado_check"
    CHECK (("reporte_herramientas_completado_at" IS NULL) = ("reporte_herramientas_completado_por" IS NULL));
COMMENT ON COLUMN "ticket"."reporte_precargado_at" IS 'Cuándo se precargó el Reporte de Herramientas con las líneas cotizadas (una sola vez): no se vuelve a agregar lo que el operador quitó.';
COMMENT ON COLUMN "ticket"."reporte_herramientas_completado_at" IS 'Cuándo el operador dio por completo el Reporte de Herramientas (se publica operaciones.pumping.reporte_herramientas_completado y Comercial lo recibe como documento operativo).';

-- 3) Celda ítem × día: una marca que vale 1 (líneas por día) o la cantidad aplicada ese día. El total de la línea es la suma.
CREATE TABLE "reporte_item_dia" (
    "id" UUID NOT NULL,
    "linea_id" UUID NOT NULL,
    "fecha" DATE NOT NULL,
    "estado" "estado_item_reporte" NOT NULL,
    "cantidad" NUMERIC(14,3) NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    CONSTRAINT "reporte_item_dia_pkey" PRIMARY KEY ("id"),
    -- una línea con días reportados no se borra
    CONSTRAINT "reporte_item_dia_linea_fkey" FOREIGN KEY ("linea_id") REFERENCES "ticket_linea" ("id") ON DELETE RESTRICT,
    CONSTRAINT "reporte_item_dia_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "reporte_item_dia_cantidad_check" CHECK ("cantidad" > 0)
);
CREATE UNIQUE INDEX "reporte_item_dia_key" ON "reporte_item_dia" ("linea_id", "fecha");
GRANT DELETE, UPDATE ON "reporte_item_dia" TO app_operaciones;
COMMENT ON TABLE "reporte_item_dia" IS 'Celda de un día de una línea del Reporte de Herramientas: operación (O), daily charge (D) o venta (V) con su cantidad (1 en las líneas por día).';

-- 4) Lo que la base garantiza de una celda: la línea no es movilización, el día no es anterior al inicio del servicio y el total de la línea
--    no pasa de lo cotizado (más allá de lo cotizado se pide un cambio de ítems, no se reporta de más). La línea se bloquea para que dos
--    celdas simultáneas no sumen por encima del tope.
CREATE FUNCTION "pumping"."validar_reporte_item_dia"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  l RECORD;
  inicio DATE;
  otros NUMERIC;
BEGIN
  SELECT * INTO l FROM "pumping"."ticket_linea" WHERE "id" = NEW."linea_id" FOR UPDATE;
  IF l."tipo_linea" = 'movilizacion' THEN
    RAISE EXCEPTION 'La línea % es de movilización: no va en el Reporte de Herramientas', l."codigo";
  END IF;
  SELECT "fecha_inicio_servicio" INTO inicio FROM "pumping"."ticket" WHERE "id" = l."ticket_id";
  IF inicio IS NOT NULL AND NEW."fecha" < inicio THEN
    RAISE EXCEPTION 'El día % es anterior al inicio del servicio (%)', NEW."fecha", inicio;
  END IF;
  SELECT COALESCE(sum("cantidad"), 0) INTO otros FROM "pumping"."reporte_item_dia"
   WHERE "linea_id" = NEW."linea_id" AND "id" <> NEW."id";
  IF otros + NEW."cantidad" > l."cantidad" THEN
    RAISE EXCEPTION 'La línea % pasa de lo cotizado (% de %)', l."codigo", otros + NEW."cantidad", l."cantidad";
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "validar_reporte_item_dia" BEFORE INSERT OR UPDATE ON "pumping"."reporte_item_dia"
  FOR EACH ROW EXECUTE FUNCTION "pumping"."validar_reporte_item_dia"();

-- El pedido puede bajar la cantidad cotizada de una línea, pero no por debajo de lo ya reportado
CREATE FUNCTION "pumping"."validar_ticket_linea_cantidad"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE reportado NUMERIC;
BEGIN
  SELECT COALESCE(sum("cantidad"), 0) INTO reportado FROM "pumping"."reporte_item_dia" WHERE "linea_id" = NEW."id";
  IF NEW."cantidad" < reportado THEN
    RAISE EXCEPTION 'La línea % ya tiene % reportado: no puede cotizarse en menos', NEW."codigo", reportado;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "validar_ticket_linea_cantidad" BEFORE UPDATE OF "cantidad" ON "pumping"."ticket_linea"
  FOR EACH ROW EXECUTE FUNCTION "pumping"."validar_ticket_linea_cantidad"();
