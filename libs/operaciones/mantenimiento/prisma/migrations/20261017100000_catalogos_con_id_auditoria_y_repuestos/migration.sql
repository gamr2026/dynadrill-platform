-- Mantenimiento: pulido de la revisión de base de datos del 17/10/2026 (no edita la migración ya aplicada).
--   1. Catálogos `tipo_suborden` y `estado_suborden`: `id uuid` + `codigo` único, y FK por id (antes la clave era el código).
--   2. Auditoría uniforme en `reporte_recibido` (created_by / updated_by).
--   3. `suborden_repuesto`: los repuestos son filas, no texto.
--   4. COMMENT que justifica las referencias entre contenedores (D1) y los permisos de lectura.
-- Las tablas de catálogo solo traían la semilla y las demás no tenían filas de negocio en producción: los ids de las filas existentes
-- se generan aquí (gen_random_uuid) y la semilla nueva ya los genera la aplicación con UUIDv7.

-- ---------------------------------------------------------------------------------------------------------------
-- 1. Catálogos con id uuid
-- ---------------------------------------------------------------------------------------------------------------
ALTER TABLE "tipo_suborden" ADD COLUMN "id" UUID;
UPDATE "tipo_suborden" SET "id" = gen_random_uuid();
ALTER TABLE "estado_suborden" ADD COLUMN "id" UUID;
UPDATE "estado_suborden" SET "id" = gen_random_uuid();

ALTER TABLE "suborden" ADD COLUMN "tipo_id" UUID, ADD COLUMN "estado_id" UUID;
UPDATE "suborden" s SET "tipo_id" = t."id" FROM "tipo_suborden" t WHERE t."codigo" = s."tipo_codigo";
UPDATE "suborden" s SET "estado_id" = e."id" FROM "estado_suborden" e WHERE e."codigo" = s."estado_codigo";

ALTER TABLE "transicion_suborden" ADD COLUMN "origen_id" UUID, ADD COLUMN "destino_id" UUID, ADD COLUMN "tipo_id" UUID;
UPDATE "transicion_suborden" x SET "origen_id" = e."id" FROM "estado_suborden" e WHERE e."codigo" = x."origen_codigo";
UPDATE "transicion_suborden" x SET "destino_id" = e."id" FROM "estado_suborden" e WHERE e."codigo" = x."destino_codigo";
UPDATE "transicion_suborden" x SET "tipo_id" = t."id" FROM "tipo_suborden" t WHERE t."codigo" = x."tipo_codigo";

-- se retiran las claves por código
ALTER TABLE "suborden" DROP CONSTRAINT "suborden_tipo_fkey", DROP CONSTRAINT "suborden_estado_fkey";
DROP INDEX "suborden_orden_tipo_key";
DROP INDEX "suborden_asignada_a_estado_idx";
DROP INDEX "suborden_estado_idx";
ALTER TABLE "transicion_suborden"
  DROP CONSTRAINT "transicion_suborden_origen_fkey",
  DROP CONSTRAINT "transicion_suborden_destino_fkey",
  DROP CONSTRAINT "transicion_suborden_tipo_fkey",
  DROP CONSTRAINT "transicion_suborden_distinta_check";
DROP INDEX "transicion_suborden_unica_key";
ALTER TABLE "suborden" DROP COLUMN "tipo_codigo", DROP COLUMN "estado_codigo";
ALTER TABLE "transicion_suborden" DROP COLUMN "origen_codigo", DROP COLUMN "destino_codigo", DROP COLUMN "tipo_codigo";

-- la clave primaria pasa a ser el id; el código queda único
ALTER TABLE "tipo_suborden" DROP CONSTRAINT "tipo_suborden_pkey";
ALTER TABLE "tipo_suborden" ALTER COLUMN "id" SET NOT NULL, ADD CONSTRAINT "tipo_suborden_pkey" PRIMARY KEY ("id"), ADD CONSTRAINT "tipo_suborden_codigo_key" UNIQUE ("codigo");
ALTER TABLE "estado_suborden" DROP CONSTRAINT "estado_suborden_pkey";
ALTER TABLE "estado_suborden" ALTER COLUMN "id" SET NOT NULL, ADD CONSTRAINT "estado_suborden_pkey" PRIMARY KEY ("id"), ADD CONSTRAINT "estado_suborden_codigo_key" UNIQUE ("codigo");

ALTER TABLE "suborden" ALTER COLUMN "tipo_id" SET NOT NULL, ALTER COLUMN "estado_id" SET NOT NULL;
ALTER TABLE "suborden"
  ADD CONSTRAINT "suborden_tipo_fkey" FOREIGN KEY ("tipo_id") REFERENCES "tipo_suborden" ("id"),
  ADD CONSTRAINT "suborden_estado_fkey" FOREIGN KEY ("estado_id") REFERENCES "estado_suborden" ("id");
-- una sub-orden por tipo en cada orden
CREATE UNIQUE INDEX "suborden_orden_tipo_key" ON "suborden" ("orden_id", "tipo_id");
CREATE INDEX "suborden_asignada_a_estado_idx" ON "suborden" ("asignada_a", "estado_id");
CREATE INDEX "suborden_estado_idx" ON "suborden" ("estado_id");

ALTER TABLE "transicion_suborden" ALTER COLUMN "origen_id" SET NOT NULL, ALTER COLUMN "destino_id" SET NOT NULL;
ALTER TABLE "transicion_suborden"
  ADD CONSTRAINT "transicion_suborden_origen_fkey" FOREIGN KEY ("origen_id") REFERENCES "estado_suborden" ("id"),
  ADD CONSTRAINT "transicion_suborden_destino_fkey" FOREIGN KEY ("destino_id") REFERENCES "estado_suborden" ("id"),
  ADD CONSTRAINT "transicion_suborden_tipo_fkey" FOREIGN KEY ("tipo_id") REFERENCES "tipo_suborden" ("id"),
  ADD CONSTRAINT "transicion_suborden_distinta_check" CHECK ("origen_id" <> "destino_id");
CREATE UNIQUE INDEX "transicion_suborden_unica_key" ON "transicion_suborden" ("origen_id", "destino_id", "tipo_id") NULLS NOT DISTINCT;

-- ---------------------------------------------------------------------------------------------------------------
-- 2. Auditoría en el reporte recibido
-- ---------------------------------------------------------------------------------------------------------------
-- `recibido_por` queda como el actor del evento que lo originó (puede ser nulo si lo recibe el sistema); la auditoría de edición
-- (clasificar, descartar) es la de siempre.
ALTER TABLE "reporte_recibido" ADD COLUMN "created_by" UUID, ADD COLUMN "updated_by" UUID;
UPDATE "reporte_recibido" SET "created_by" = "recibido_por", "updated_by" = COALESCE("descartado_por", "recibido_por");
ALTER TABLE "reporte_recibido"
  ADD CONSTRAINT "reporte_recibido_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
  ADD CONSTRAINT "reporte_recibido_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id");

-- ---------------------------------------------------------------------------------------------------------------
-- 3. Repuestos de la sub-orden
-- ---------------------------------------------------------------------------------------------------------------
-- Hoy (consulta M-3) son número de parte, cantidad y descripción; `articulo_id` los enlaza a Inventario cuando el repuesto existe
-- en su catálogo (mismo contenedor: FK real). Al guardar el avance se reemplazan las filas (de ahí el DELETE).
CREATE TABLE "suborden_repuesto" (
    "id" UUID NOT NULL,
    "suborden_id" UUID NOT NULL,
    "numero_parte" TEXT NOT NULL,
    "cantidad" NUMERIC(10,2) NOT NULL,
    "descripcion" TEXT,
    "articulo_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    CONSTRAINT "suborden_repuesto_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "suborden_repuesto_suborden_fkey" FOREIGN KEY ("suborden_id") REFERENCES "suborden" ("id") ON DELETE CASCADE,
    CONSTRAINT "suborden_repuesto_articulo_fkey" FOREIGN KEY ("articulo_id") REFERENCES inventario.articulo ("id"),
    CONSTRAINT "suborden_repuesto_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "suborden_repuesto_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "suborden_repuesto_cantidad_check" CHECK ("cantidad" > 0),
    CONSTRAINT "suborden_repuesto_parte_check" CHECK (length(btrim("numero_parte")) > 0)
);
-- un número de parte una sola vez por sub-orden (se suma la cantidad)
CREATE UNIQUE INDEX "suborden_repuesto_parte_key" ON "suborden_repuesto" ("suborden_id", "numero_parte");
CREATE INDEX "suborden_repuesto_articulo_idx" ON "suborden_repuesto" ("articulo_id") WHERE "articulo_id" IS NOT NULL;
GRANT DELETE ON "suborden_repuesto" TO app_operaciones;

-- ---------------------------------------------------------------------------------------------------------------
-- 4. Comentarios y permisos
-- ---------------------------------------------------------------------------------------------------------------
COMMENT ON COLUMN "reporte_recibido"."qhse_referencia_id" IS 'Caso de QHSE que originó el reporte. SIN FK a propósito: QHSE es otro contenedor (decisión D1); se valida por evento/contrato.';
COMMENT ON COLUMN "reporte_recibido"."novedad_qhse" IS 'Texto de la novedad, copiado del evento de QHSE (otro contenedor, D1: no se puede hacer JOIN). Único texto copiado de otro módulo; se actualiza por evento. Para Pumping NO se copia: se lee de pumping.reporte_unidad.';
COMMENT ON COLUMN "reporte_recibido"."pumping_reporte_unidad_id" IS 'FK a pumping.reporte_unidad (mismo contenedor). Pumping no debe cambiar esa tabla sin avisar por el registro de cambios (contrato 4.2).';
COMMENT ON TABLE "suborden_repuesto" IS 'Repuestos usados en una sub-orden: número de parte, cantidad y descripción; articulo_id enlaza al catálogo de Inventario cuando existe.';
COMMENT ON TABLE "tipo_suborden" IS 'Catálogo del sistema (mecánico, instrumental, operativo): se siembra, no lo edita el usuario, por eso no lleva auditoría de edición.';
COMMENT ON TABLE "estado_suborden" IS 'Catálogo del sistema de los estados de la sub-orden; con transicion_suborden forma la máquina de estados.';

-- Lectura mínima de las tablas maestras (ya concedida por otros módulos; se repite para que este módulo no dependa de ellos).
-- No se lee ningún dato personal: solo quién es la cuenta (nombre, correo para los avisos, si está activa y su rol).
GRANT USAGE ON SCHEMA identidad, inventario TO app_operaciones;
GRANT SELECT (id, nombre, email, activo, rol_id) ON identidad.usuario TO app_operaciones;
GRANT SELECT (id, codigo, nombre) ON identidad.rol TO app_operaciones;
