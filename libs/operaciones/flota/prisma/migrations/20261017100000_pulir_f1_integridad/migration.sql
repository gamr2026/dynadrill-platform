-- Flota F1, revisión de base de datos del 17/10/2026 (ver plan-flota.md, «Hallazgos» y «Estándar de calidad»).

-- 1. `unidad_lectura.fuente_id` era un id polimórfico sin FK: se retira. Para las lecturas de un mantenimiento el origen ya está en
--    `unidad_preventivo.lectura_id` (FK). Cuando existan las inspecciones (F2) y el reporte de unidad se agregarán columnas con FK
--    propias y un CHECK de que solo la del origen esté llena; hasta entonces `fuente` solo clasifica.
ALTER TABLE "unidad_lectura" DROP COLUMN "fuente_id";

-- 2. El tipo de lectura de una unidad lo decide su tipo (servicio = horómetro, transporte = odómetro, auxiliar = ninguna). Se garantiza
--    en la base con una columna generada y una FK compuesta, no solo en el servicio.
ALTER TABLE "unidad"
  ADD COLUMN "tipo_lectura" "tipo_lectura" GENERATED ALWAYS AS (
    CASE "tipo" WHEN 'servicio' THEN 'horometro'::"tipo_lectura" WHEN 'transporte' THEN 'odometro'::"tipo_lectura" END
  ) STORED;
ALTER TABLE "unidad" ADD CONSTRAINT "unidad_id_tipo_lectura_key" UNIQUE ("id", "tipo_lectura");
ALTER TABLE "unidad_lectura"
  ADD CONSTRAINT "unidad_lectura_unidad_tipo_fkey" FOREIGN KEY ("unidad_id", "tipo") REFERENCES "unidad" ("id", "tipo_lectura");

-- 3. Historia inmutable: las lecturas y los preventivos no se editan ni se borran desde la aplicación. Un error se corrige anulando
--    el registro (tabla propia, solo INSERT) y registrando uno nuevo.
CREATE TABLE "unidad_lectura_anulacion" (
    "lectura_id" UUID NOT NULL,
    "anulada_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "anulada_por" UUID NOT NULL,
    "motivo" TEXT NOT NULL,
    CONSTRAINT "unidad_lectura_anulacion_pkey" PRIMARY KEY ("lectura_id"),
    CONSTRAINT "unidad_lectura_anulacion_motivo_check" CHECK (char_length(btrim("motivo")) >= 5)
);
ALTER TABLE "unidad_lectura_anulacion"
  ADD CONSTRAINT "unidad_lectura_anulacion_lectura_id_fkey" FOREIGN KEY ("lectura_id") REFERENCES "unidad_lectura" ("id") ON DELETE CASCADE,
  ADD CONSTRAINT "unidad_lectura_anulacion_anulada_por_fkey" FOREIGN KEY ("anulada_por") REFERENCES identidad.usuario ("id");

CREATE TABLE "unidad_preventivo_anulacion" (
    "preventivo_id" UUID NOT NULL,
    "anulada_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "anulada_por" UUID NOT NULL,
    "motivo" TEXT NOT NULL,
    CONSTRAINT "unidad_preventivo_anulacion_pkey" PRIMARY KEY ("preventivo_id"),
    CONSTRAINT "unidad_preventivo_anulacion_motivo_check" CHECK (char_length(btrim("motivo")) >= 5)
);
ALTER TABLE "unidad_preventivo_anulacion"
  ADD CONSTRAINT "unidad_preventivo_anulacion_preventivo_id_fkey" FOREIGN KEY ("preventivo_id") REFERENCES "unidad_preventivo" ("id") ON DELETE CASCADE,
  ADD CONSTRAINT "unidad_preventivo_anulacion_anulada_por_fkey" FOREIGN KEY ("anulada_por") REFERENCES identidad.usuario ("id");

REVOKE UPDATE, DELETE ON "unidad_lectura", "unidad_preventivo", "unidad_lectura_anulacion", "unidad_preventivo_anulacion" FROM app_operaciones;

-- 4. Los preventivos de la carga inicial (historial de la demo, sin cuenta responsable) quedan marcados para distinguirlos de los que
--    registra la aplicación; estos últimos siempre llevan responsable.
CREATE TYPE "origen_registro" AS ENUM ('carga_inicial', 'aplicacion');
ALTER TABLE "unidad_preventivo" ADD COLUMN "origen" "origen_registro" NOT NULL DEFAULT 'aplicacion';
UPDATE "unidad_preventivo" SET "origen" = 'carga_inicial' WHERE "responsable_id" IS NULL AND "created_by" IS NULL;
ALTER TABLE "unidad_preventivo"
  ADD CONSTRAINT "unidad_preventivo_responsable_check" CHECK ("origen" = 'carga_inicial' OR "responsable_id" IS NOT NULL);

-- 5. Permisos de lectura mínimos sobre el catálogo de transporte: solo las columnas que usa Flota (y Pumping: id, placa, marca,
--    modelo, tipo y habilitado). Sin datos del transportista.
REVOKE SELECT ON catalogos.vehiculo, catalogos.tipo_vehiculo FROM app_operaciones;
GRANT SELECT (id, placa, marca, modelo, anio, tipo_vehiculo_id, habilitado) ON catalogos.vehiculo TO app_operaciones;
GRANT SELECT (id, nombre) ON catalogos.tipo_vehiculo TO app_operaciones;

COMMENT ON COLUMN "unidad"."tipo" IS 'Enum: el tipo decide la regla preventiva (MAN-002) y la lectura que lleva; Dynadrill no lo amplía (Plan de Mantenimiento 2026).';
COMMENT ON COLUMN "unidad"."nombre" IS 'Nombre operativo de la unidad; la matrícula (placa, marca, modelo, año) NO se guarda aquí: sale de catalogos.vehiculo por vehiculo_id.';
COMMENT ON COLUMN "unidad_lectura"."fuente" IS 'Origen de la lectura. La referencia al documento de origen se agrega con FK por origen (inspección en F2).';
