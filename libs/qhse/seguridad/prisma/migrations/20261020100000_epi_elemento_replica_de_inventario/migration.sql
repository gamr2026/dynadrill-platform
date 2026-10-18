-- QHSE, decisión D16 (17/10/2026): los elementos de EPI son artículos de Inventario (categoría EPP de AS2, marcados `entrega_personal`),
-- no un catálogo propio inventado. Inventario está en otro contenedor (operaciones) y no se puede hacer FK entre contenedores (D1):
-- `epi_elemento` pasa a ser una RÉPLICA de esos artículos que se mantiene por el evento
-- `operaciones.inventario.articulo_epi_actualizado`. La talla sigue siendo un catálogo de QHSE (`epi_talla`): la talla no es parte del
-- artículo, se elige al entregar (AS2 la tenía en el nombre del producto, como productos aparte).

-- Los 12 elementos sembrados eran una lista «habitual» inventada (el formato DYN-SGI-RE-032 solo trae la tabla vacía): no hay forma de
-- relacionarlos con los artículos reales. Si alguna entrega ya los usa, hay que resolverlo a mano antes.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "epi_entrega_item") THEN
    RAISE EXCEPTION 'Hay renglones de entregas de EPI con elementos del catálogo anterior: asócielos a artículos de Inventario a mano antes de aplicar esta migración';
  END IF;
END
$$;

DELETE FROM "epi_elemento";

ALTER TABLE "epi_elemento"
  ADD COLUMN "articulo_id" UUID NOT NULL,
  ADD COLUMN "sincronizado_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  DROP COLUMN "orden";
CREATE UNIQUE INDEX "epi_elemento_articulo_id_key" ON "epi_elemento" ("articulo_id");

-- el código es el del producto en AS2 (EPP-0004): ya no es un código estable en minúsculas, y el nombre puede repetirse
DROP INDEX IF EXISTS "epi_elemento_nombre_key";
ALTER TABLE "epi_elemento" DROP CONSTRAINT "epi_elemento_codigo_check";
ALTER TABLE "epi_elemento" ADD CONSTRAINT "epi_elemento_codigo_check" CHECK (length(btrim("codigo")) > 0);

COMMENT ON TABLE "epi_elemento" IS 'RÉPLICA de los artículos de Inventario que se entregan a una persona (inventario.articulo con entrega_personal). Se mantiene por el evento operaciones.inventario.articulo_epi_actualizado; no se edita desde QHSE. Sin FK: Inventario es otro contenedor (D1).';
COMMENT ON COLUMN "epi_elemento"."articulo_id" IS 'Id del artículo en Inventario (contenedor operaciones). Sin FK entre contenedores (D1); solo existe si llegó su evento.';
COMMENT ON COLUMN "epi_elemento"."codigo" IS 'COPIA justificada: código del producto en AS2. QHSE lo muestra en bandejas y hojas y no puede obtenerlo con un JOIN. Se mantiene por evento.';
COMMENT ON COLUMN "epi_elemento"."nombre" IS 'COPIA justificada: nombre del artículo, por la misma razón que el código. Se mantiene por evento.';
COMMENT ON COLUMN "epi_elemento"."tipo_talla" IS 'COPIA justificada: tipo de talla que admite el artículo (ropa, calzado, guante; nulo = no lleva). Lo decide Inventario.';
COMMENT ON COLUMN "epi_elemento"."activo" IS 'Falso si el artículo se dio de baja o dejó de entregarse a una persona en Inventario.';
COMMENT ON COLUMN "epi_elemento"."sincronizado_at" IS 'Momento del último evento aplicado (occurredAt del evento): un evento más viejo no pisa a uno más nuevo.';
