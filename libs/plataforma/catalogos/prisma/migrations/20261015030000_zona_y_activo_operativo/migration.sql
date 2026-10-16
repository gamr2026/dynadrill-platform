-- Zona y activo operativo dejan de ser texto suelto en `campo`: pasan a catálogos propios (tabla con `id`) y el campo
-- los referencia por clave foránea. Los valores que ya existían se conservan.

CREATE TABLE "zona" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "nombre" TEXT NOT NULL,
    "habilitado" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "zona_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "zona_nombre_key" ON "zona"("nombre");

CREATE TABLE "activo_operativo" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "nombre" TEXT NOT NULL,
    "habilitado" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "activo_operativo_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "activo_operativo_nombre_key" ON "activo_operativo"("nombre");

-- Los valores distintos que ya había (sin importar mayúsculas ni espacios sobrantes) pasan a los catálogos.
INSERT INTO "zona" ("id", "nombre")
SELECT gen_random_uuid(), x.nombre
FROM (SELECT DISTINCT ON (upper(btrim("zona"))) btrim("zona") AS nombre FROM "campo" WHERE btrim(coalesce("zona", '')) <> '' ORDER BY upper(btrim("zona")), btrim("zona")) x;

INSERT INTO "activo_operativo" ("id", "nombre")
SELECT gen_random_uuid(), x.nombre
FROM (SELECT DISTINCT ON (upper(btrim("activo_operativo"))) btrim("activo_operativo") AS nombre FROM "campo" WHERE btrim(coalesce("activo_operativo", '')) <> '' ORDER BY upper(btrim("activo_operativo")), btrim("activo_operativo")) x;

ALTER TABLE "campo" ADD COLUMN "zona_id" UUID, ADD COLUMN "activo_operativo_id" UUID;
UPDATE "campo" c SET "zona_id" = z."id" FROM "zona" z WHERE upper(btrim(c."zona")) = upper(z."nombre");
UPDATE "campo" c SET "activo_operativo_id" = a."id" FROM "activo_operativo" a WHERE upper(btrim(c."activo_operativo")) = upper(a."nombre");

ALTER TABLE "campo" DROP COLUMN "zona", DROP COLUMN "activo_operativo";

ALTER TABLE "campo" ADD CONSTRAINT "campo_zona_id_fkey" FOREIGN KEY ("zona_id") REFERENCES "zona"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "campo" ADD CONSTRAINT "campo_activo_operativo_id_fkey" FOREIGN KEY ("activo_operativo_id") REFERENCES "activo_operativo"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "campo_zona_id_idx" ON "campo"("zona_id");
CREATE INDEX "campo_activo_operativo_id_idx" ON "campo"("activo_operativo_id");

COMMENT ON TABLE "zona" IS 'Catálogo de zonas comerciales; cada campo pertenece a una.';
COMMENT ON TABLE "activo_operativo" IS 'Catálogo de activos operativos de Petroecuador (AIT, AM, AP...).';
