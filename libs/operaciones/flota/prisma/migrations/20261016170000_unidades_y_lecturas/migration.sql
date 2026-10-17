-- Flota, tramo F1: unidades, lecturas (horómetro y odómetro), reglas y registros del mantenimiento preventivo.
-- La unidad es la entidad operativa de Dynadrill (código PUM-07, tipo, lecturas). Los datos de matrícula (placa, marca, modelo, año)
-- no se copian: se obtienen con JOIN de `catalogos.vehiculo` (decisión D2, `vehiculo_id` opcional).

CREATE TYPE "tipo_unidad" AS ENUM ('servicio', 'auxiliar', 'transporte');
CREATE TYPE "categoria_peso" AS ENUM ('pesado', 'liviano');
CREATE TYPE "tipo_lectura" AS ENUM ('horometro', 'odometro');
CREATE TYPE "fuente_lectura" AS ENUM ('carga_inicial', 'manual', 'inspeccion', 'reporte_unidad', 'mantenimiento');
CREATE TYPE "tipo_servicio_preventivo" AS ENUM ('a', 'b');
CREATE TYPE "metrica_preventiva" AS ENUM ('horas', 'km', 'dias');
CREATE TYPE "ejecutado_por" AS ENUM ('interno', 'tercero');

-- Lectura de las tablas maestras (solo lo necesario; de `identidad.usuario` nunca la clave ni los datos de acceso)
GRANT USAGE ON SCHEMA catalogos, identidad, archivos TO app_operaciones;
GRANT SELECT ON catalogos.vehiculo, catalogos.tipo_vehiculo TO app_operaciones;
GRANT SELECT (id, nombre, email, activo, rol_id) ON identidad.usuario TO app_operaciones;
GRANT SELECT (id, codigo, nombre) ON identidad.rol TO app_operaciones;
GRANT SELECT (id, nombre_original, mime_type, tamano_bytes, subido_por) ON archivos.archivo TO app_operaciones;

-- Catálogo de proveedores externos de mantenimiento
CREATE TABLE "proveedor_mantenimiento" (
    "id" UUID NOT NULL,
    "nombre" TEXT NOT NULL,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    CONSTRAINT "proveedor_mantenimiento_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "proveedor_mantenimiento_nombre_key" ON "proveedor_mantenimiento"("nombre");
ALTER TABLE "proveedor_mantenimiento"
  ADD CONSTRAINT "proveedor_mantenimiento_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
  ADD CONSTRAINT "proveedor_mantenimiento_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id");

-- Reglas del Plan de Mantenimiento 2026 (MAN-002): qué se controla en cada tipo de unidad, cada cuánto y con qué tolerancia.
CREATE TABLE "regla_preventiva" (
    "codigo" TEXT NOT NULL,
    "tipo_unidad" "tipo_unidad" NOT NULL,
    "tipo_servicio" "tipo_servicio_preventivo",
    "metrica" "metrica_preventiva" NOT NULL,
    "intervalo" INTEGER NOT NULL,
    "tolerancia" INTEGER NOT NULL DEFAULT 0,
    "descripcion" TEXT NOT NULL,
    "activa" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "regla_preventiva_pkey" PRIMARY KEY ("codigo"),
    CONSTRAINT "regla_preventiva_intervalo_check" CHECK ("intervalo" > 0 AND "tolerancia" >= 0)
);

-- Unidad
CREATE TABLE "unidad" (
    "id" UUID NOT NULL,
    "codigo" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "tipo" "tipo_unidad" NOT NULL,
    "categoria_peso" "categoria_peso",
    "vehiculo_id" UUID,
    "proveedor_mantenimiento_id" UUID,
    "fecha_matricula" DATE,
    "caducidad_matricula" DATE,
    "caducidad_poliza" DATE,
    "vigencia_otro_documento" DATE,
    "responsable_patrimonial_id" UUID,
    "predeterminada" BOOLEAN NOT NULL DEFAULT false,
    "nota" TEXT,
    "activa" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    CONSTRAINT "unidad_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "unidad_categoria_peso_check" CHECK ("categoria_peso" IS NULL OR "tipo" = 'transporte')
);
CREATE UNIQUE INDEX "unidad_codigo_key" ON "unidad"("codigo");
CREATE UNIQUE INDEX "unidad_vehiculo_id_key" ON "unidad"("vehiculo_id");
CREATE INDEX "unidad_tipo_idx" ON "unidad"("tipo");
ALTER TABLE "unidad"
  ADD CONSTRAINT "unidad_vehiculo_id_fkey" FOREIGN KEY ("vehiculo_id") REFERENCES catalogos.vehiculo ("id"),
  ADD CONSTRAINT "unidad_proveedor_mantenimiento_id_fkey" FOREIGN KEY ("proveedor_mantenimiento_id") REFERENCES "proveedor_mantenimiento" ("id"),
  ADD CONSTRAINT "unidad_responsable_patrimonial_id_fkey" FOREIGN KEY ("responsable_patrimonial_id") REFERENCES identidad.usuario ("id"),
  ADD CONSTRAINT "unidad_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
  ADD CONSTRAINT "unidad_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id");

-- Lecturas: histórico de horómetro y odómetro. La lectura vigente es la última (nunca una columna editable).
CREATE TABLE "unidad_lectura" (
    "id" UUID NOT NULL,
    "unidad_id" UUID NOT NULL,
    "tipo" "tipo_lectura" NOT NULL,
    "valor" NUMERIC(12,1) NOT NULL,
    "leida_at" TIMESTAMPTZ(6) NOT NULL,
    "fuente" "fuente_lectura" NOT NULL,
    "fuente_id" UUID,
    "registrada_por" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "unidad_lectura_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "unidad_lectura_valor_check" CHECK ("valor" >= 0)
);
CREATE INDEX "unidad_lectura_unidad_id_tipo_leida_at_idx" ON "unidad_lectura"("unidad_id", "tipo", "leida_at" DESC);
ALTER TABLE "unidad_lectura"
  ADD CONSTRAINT "unidad_lectura_unidad_id_fkey" FOREIGN KEY ("unidad_id") REFERENCES "unidad" ("id") ON DELETE CASCADE,
  ADD CONSTRAINT "unidad_lectura_registrada_por_fkey" FOREIGN KEY ("registrada_por") REFERENCES identidad.usuario ("id");

-- Mantenimientos preventivos ejecutados (A/B en las de servicio; por kilometraje o por tiempo en las demás).
-- El horómetro o el kilometraje de ese momento es una lectura (`lectura_id`), no una columna copiada.
CREATE TABLE "unidad_preventivo" (
    "id" UUID NOT NULL,
    "unidad_id" UUID NOT NULL,
    "tipo_servicio" "tipo_servicio_preventivo",
    "fecha" DATE NOT NULL,
    "lectura_id" UUID,
    "ejecutado_por" "ejecutado_por" NOT NULL,
    "proveedor_mantenimiento_id" UUID,
    "responsable_id" UUID NOT NULL,
    "observaciones" TEXT,
    "checklist_archivo_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    CONSTRAINT "unidad_preventivo_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "unidad_preventivo_tercero_check" CHECK ("ejecutado_por" = 'interno' OR "proveedor_mantenimiento_id" IS NOT NULL)
);
CREATE INDEX "unidad_preventivo_unidad_id_fecha_idx" ON "unidad_preventivo"("unidad_id", "fecha" DESC);
ALTER TABLE "unidad_preventivo"
  ADD CONSTRAINT "unidad_preventivo_unidad_id_fkey" FOREIGN KEY ("unidad_id") REFERENCES "unidad" ("id") ON DELETE CASCADE,
  ADD CONSTRAINT "unidad_preventivo_lectura_id_fkey" FOREIGN KEY ("lectura_id") REFERENCES "unidad_lectura" ("id"),
  ADD CONSTRAINT "unidad_preventivo_proveedor_mantenimiento_id_fkey" FOREIGN KEY ("proveedor_mantenimiento_id") REFERENCES "proveedor_mantenimiento" ("id"),
  ADD CONSTRAINT "unidad_preventivo_responsable_id_fkey" FOREIGN KEY ("responsable_id") REFERENCES identidad.usuario ("id"),
  ADD CONSTRAINT "unidad_preventivo_checklist_archivo_id_fkey" FOREIGN KEY ("checklist_archivo_id") REFERENCES archivos.archivo ("id"),
  ADD CONSTRAINT "unidad_preventivo_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id");

COMMENT ON TABLE "unidad" IS 'Unidad operativa de Dynadrill (equipo de servicio, auxiliar o de transporte). Dueño: Flota. Los datos de matrícula salen de catalogos.vehiculo.';
COMMENT ON TABLE "unidad_lectura" IS 'Histórico de horómetro/odómetro. La lectura vigente es la más reciente por unidad y tipo.';
