-- CM-4 y OP-6 (PARIDAD-MODELO-DEMO.md): la unidad deja de ser texto libre en Comercial y Operaciones y pasa a ser FK a este
-- catálogo. Aquí:
--  1. el período de las unidades de tiempo (antes FCR lo deducía del texto con una expresión regular y tenía su propio catálogo
--     `fcr.unidad_cotizacion` con `es_tiempo`, que se retira): «de tiempo» = tiene período; «por día» = período día;
--  2. las unidades que usan las listas de precios y FCR y que el catálogo no tenía. Van en la migración, no solo en la semilla,
--     porque las migraciones de Comercial y Operaciones que traducen el texto a FK las necesitan. Lo que ya existe por nombre
--     no se toca (mismo criterio que la semilla).
CREATE TYPE "catalogos"."periodo_unidad" AS ENUM ('hora', 'dia', 'semana', 'mes');
ALTER TABLE "catalogos"."unidad_medida" ADD COLUMN "periodo" "catalogos"."periodo_unidad";

INSERT INTO "catalogos"."unidad_medida" ("id", "nombre", "simbolo", "periodo")
SELECT gen_random_uuid(), v.nombre, v.simbolo, v.periodo::"catalogos"."periodo_unidad"
FROM (VALUES
  ('Unidad', 'und', NULL), ('Galón', 'gal', NULL), ('Litro', 'l', NULL), ('Kilogramo', 'kg', NULL), ('Barril', 'bbl', NULL),
  ('Metro cuadrado', 'm2', NULL), ('Libra', 'lb', NULL), ('Saco', 'sc', NULL), ('Tambor', 'tbr', NULL), ('Balde', 'bld', NULL),
  ('Caja', 'cja', NULL), ('Metro', 'm', NULL), ('Pie', 'ft', NULL), ('Par', 'par', NULL), ('Juego', 'jgo', NULL),
  ('Hora', 'h', 'hora'), ('Día', 'd', 'dia'), ('Semana', 'sem', 'semana'), ('Mes', 'mes', 'mes'),
  ('Corrida', 'corrida', NULL), ('Servicio', 'serv', NULL), ('Trabajo', 'trabajo', NULL), ('Kilómetro', 'km', NULL),
  ('Metro cúbico', 'm3', NULL), ('Pie cúbico', 'ft3', NULL), ('Tonelada', 't', NULL), ('Tonelada·kilómetro', 't·km', NULL),
  ('HHP·hora', 'HHP·h', NULL)
) AS v(nombre, simbolo, periodo)
WHERE NOT EXISTS (
  SELECT 1 FROM "catalogos"."unidad_medida" u WHERE lower(btrim(u."nombre")) = lower(btrim(v.nombre))
);
-- si las de tiempo ya existían (sembradas antes), toman su período
UPDATE "catalogos"."unidad_medida" u SET "periodo" = v.periodo::"catalogos"."periodo_unidad"
FROM (VALUES ('hora', 'hora'), ('día', 'dia'), ('semana', 'semana'), ('mes', 'mes')) AS v(nombre, periodo)
WHERE lower(btrim(u."nombre")) = v.nombre AND u."periodo" IS NULL;

-- Comercial también la referencia con FK (listas de precios e ítems del pedido); solo la lee
GRANT SELECT ON "catalogos"."unidad_medida" TO app_comercial;

COMMENT ON TABLE "catalogos"."unidad_medida" IS 'Unidades de medida compartidas (IN9, CM-4): Inventario, Comercial y Operaciones las referencian con FK. No se borran: se inhabilitan. Se administran en el portal; la equivalencia con los códigos de unidad de AS2 (exportación) es la consulta C11.';
COMMENT ON COLUMN "catalogos"."unidad_medida"."periodo" IS 'Período de las unidades de tiempo (nulo en las demás). FCR pide un solo juego del kit por línea de tiempo; las filas en días se reportan con marcas por día.';
