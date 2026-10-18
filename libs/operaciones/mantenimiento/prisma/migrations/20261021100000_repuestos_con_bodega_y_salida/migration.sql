-- Repuestos de la sub-orden: el operador elige el repuesto del catálogo de Inventario (con la bodega de la que sale) o, si no existe
-- en el catálogo, lo escribe como texto. Al aprobar el cierre, cada repuesto del catálogo sale de bodega por el kardex.
--   1. Un renglón es DE CATÁLOGO (artículo + bodega, sin texto: el código y el nombre se leen con JOIN, no se copian) o es TEXTO
--      (número de parte y, si hace falta, descripción; sin artículo ni bodega). Antes el número de parte se pedía siempre.
--   2. `movimiento_id`: la salida del kardex que lo respalda (FK a inventario.movimiento; se llena al aprobar el cierre).
--   3. Un renglón con salida registrada ya no se puede cambiar ni borrar (el kardex es inmutable).

ALTER TABLE "suborden_repuesto" ALTER COLUMN "numero_parte" DROP NOT NULL;
ALTER TABLE "suborden_repuesto" ADD COLUMN "bodega_id" UUID, ADD COLUMN "movimiento_id" UUID;

ALTER TABLE "suborden_repuesto"
    ADD CONSTRAINT "suborden_repuesto_bodega_fkey" FOREIGN KEY ("bodega_id") REFERENCES catalogos.bodega ("id"),
    ADD CONSTRAINT "suborden_repuesto_movimiento_fkey" FOREIGN KEY ("movimiento_id") REFERENCES inventario.movimiento ("id"),
    ADD CONSTRAINT "suborden_repuesto_origen_check" CHECK (
        ("articulo_id" IS NOT NULL AND "bodega_id" IS NOT NULL AND "numero_parte" IS NULL AND "descripcion" IS NULL)
        OR ("articulo_id" IS NULL AND "bodega_id" IS NULL AND "numero_parte" IS NOT NULL)
    ),
    ADD CONSTRAINT "suborden_repuesto_movimiento_check" CHECK ("movimiento_id" IS NULL OR "articulo_id" IS NOT NULL);

-- un artículo del catálogo una sola vez por sub-orden (se suma la cantidad); una salida respalda un solo renglón
CREATE UNIQUE INDEX "suborden_repuesto_articulo_key" ON "suborden_repuesto" ("suborden_id", "articulo_id") WHERE "articulo_id" IS NOT NULL;
CREATE UNIQUE INDEX "suborden_repuesto_movimiento_key" ON "suborden_repuesto" ("movimiento_id") WHERE "movimiento_id" IS NOT NULL;
CREATE INDEX "suborden_repuesto_bodega_idx" ON "suborden_repuesto" ("bodega_id") WHERE "bodega_id" IS NOT NULL;

CREATE FUNCTION mantenimiento.proteger_repuesto_con_salida() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD."movimiento_id" IS NOT NULL THEN
        RAISE EXCEPTION 'El repuesto ya salió de bodega (movimiento %): no se puede cambiar ni borrar', OLD."movimiento_id"
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER "suborden_repuesto_con_salida" BEFORE UPDATE OR DELETE ON "suborden_repuesto"
    FOR EACH ROW EXECUTE FUNCTION mantenimiento.proteger_repuesto_con_salida();

COMMENT ON TABLE "suborden_repuesto" IS 'Repuestos usados en una sub-orden. De catálogo (articulo_id + bodega_id, sin texto) o de texto (numero_parte y descripción, cuando el repuesto no está en Inventario). Al aprobar el cierre, los de catálogo salen de bodega y guardan movimiento_id.';
COMMENT ON COLUMN "suborden_repuesto"."numero_parte" IS 'Solo en los repuestos de texto. En los de catálogo el código se lee de inventario.articulo (no se copia).';
COMMENT ON COLUMN "suborden_repuesto"."bodega_id" IS 'Bodega (catalogos.bodega) de la que sale el repuesto de catálogo.';
COMMENT ON COLUMN "suborden_repuesto"."movimiento_id" IS 'Salida del kardex (inventario.movimiento) que respalda el renglón; se llena al aprobar el cierre. Con ella el renglón queda protegido contra cambios y borrados.';

GRANT USAGE ON SCHEMA catalogos TO app_operaciones;
GRANT SELECT (id, nombre, habilitado) ON catalogos.bodega TO app_operaciones;
