-- IN9: la unidad de medida pasa a ser un catálogo compartido de la plataforma (hoy la usa Inventario; Comercial y FCR se enlazan cuando
-- Asinfo confirme la equivalencia de unidades, consulta C11). Los datos de `inventario.unidad_stock` los traslada la migración de
-- Inventario `20261024134000_unidad_medida_compartida`, que debe correr DESPUÉS de esta.

CREATE TABLE "catalogos"."unidad_medida" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "nombre" TEXT NOT NULL,
    "simbolo" TEXT NOT NULL,
    "habilitado" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "unidad_medida_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "unidad_medida_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "unidad_medida_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "unidad_medida_nombre_check" CHECK (length(btrim("nombre")) > 0),
    CONSTRAINT "unidad_medida_simbolo_check" CHECK (length(btrim("simbolo")) > 0)
);
CREATE UNIQUE INDEX "unidad_medida_nombre_key" ON "catalogos"."unidad_medida" ("nombre");
-- «Litro» y «litro» no conviven: el servicio lo valida y la base lo garantiza
CREATE UNIQUE INDEX "unidad_medida_nombre_minusculas_key" ON "catalogos"."unidad_medida" (lower(btrim("nombre")));

-- Otros contenedores solo la leen (FK real desde sus tablas); no la escriben
GRANT SELECT ON "catalogos"."unidad_medida" TO app_operaciones;

COMMENT ON TABLE "catalogos"."unidad_medida" IS 'Unidades de medida compartidas (IN9). No se borran: se inhabilitan, porque otros módulos las referencian con FK.';
COMMENT ON COLUMN "catalogos"."unidad_medida"."simbolo" IS 'Abreviatura que se imprime junto a las cantidades (kg, gal, und).';
