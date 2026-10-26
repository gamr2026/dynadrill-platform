-- DashboardMetas (PARIDAD-MODELO-DEMO.md): las metas del tablero HSE (HSE-MASTER-001) eran un JSON {indicador: meta} en la demo. Ahora hay un
-- catálogo de indicadores (los 16 del documento) y las metas son filas con historial: una meta nueva reemplaza a la anterior sin borrarla.
CREATE TYPE "kpi_categoria" AS ENUM ('seguridad', 'operacional', 'ambiental', 'cultura_preventiva');
CREATE TYPE "kpi_direccion" AS ENUM ('mayor_mejor', 'menor_mejor');

CREATE TABLE "kpi_indicador" (
    "id" UUID NOT NULL,
    "codigo" TEXT NOT NULL,
    "categoria" "kpi_categoria" NOT NULL,
    "nombre" TEXT NOT NULL,
    "unidad" TEXT NOT NULL,
    "direccion" "kpi_direccion" NOT NULL,
    "orden" SMALLINT NOT NULL,
    "disponible" BOOLEAN NOT NULL,
    "motivo_no_disponible" TEXT,
    CONSTRAINT "kpi_indicador_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "kpi_indicador_codigo_key" UNIQUE ("codigo"),
    CONSTRAINT "kpi_indicador_orden_key" UNIQUE ("orden"),
    CONSTRAINT "kpi_indicador_textos_check" CHECK (length(btrim("codigo")) > 0 AND length(btrim("nombre")) > 0 AND length(btrim("unidad")) > 0),
    -- un indicador que no se puede calcular dice por qué; uno que sí, no
    CONSTRAINT "kpi_indicador_motivo_check" CHECK ("disponible" = ("motivo_no_disponible" IS NULL))
);
COMMENT ON TABLE "kpi_indicador" IS 'Indicadores del Dashboard Integrado del Sistema (HSE-MASTER-001). Los define el sistema; `disponible` indica si hay datos para calcularlos.';
COMMENT ON COLUMN "kpi_indicador"."direccion" IS 'mayor_mejor: está fuera de meta si el valor es menor que la meta; menor_mejor: si es mayor.';

INSERT INTO "kpi_indicador" ("id", "codigo", "categoria", "nombre", "unidad", "direccion", "orden", "disponible", "motivo_no_disponible") VALUES
  (gen_random_uuid(), 'trir', 'seguridad', 'TRIR (Total Recordable Incident Rate)', 'x 200,000 h-h', 'menor_mejor', 1, false, 'Requiere horas-hombre trabajadas: no se registran en el sistema.'),
  (gen_random_uuid(), 'ltir', 'seguridad', 'LTIR (Lost Time Incident Rate)', 'x 200,000 h-h', 'menor_mejor', 2, false, 'Requiere horas-hombre trabajadas: no se registran en el sistema.'),
  (gen_random_uuid(), 'dias_sin_lti', 'seguridad', 'Días sin accidentes con tiempo perdido', 'días', 'mayor_mejor', 3, true, NULL),
  (gen_random_uuid(), 'ratio_near_miss', 'seguridad', 'Ratio Near Miss : Incidentes', ': 1', 'mayor_mejor', 4, true, NULL),
  (gen_random_uuid(), 'ptw_cerrados_pct', 'operacional', '% de PTW aprobados', '%', 'mayor_mejor', 5, true, NULL),
  (gen_random_uuid(), 'inspecciones_vigentes_pct', 'operacional', '% de inspecciones vigentes', '%', 'mayor_mejor', 6, true, NULL),
  (gen_random_uuid(), 'ptw_tiempo_prom_dias', 'operacional', 'Tiempo promedio apertura → aprobación PTW', 'días', 'menor_mejor', 7, true, NULL),
  (gen_random_uuid(), 'iperc_vigente_pct', 'operacional', '% de PTW con IPERC vigente (aprobada)', '%', 'mayor_mejor', 8, false, 'La Matriz IPERC es maestra y anual (no se vincula por PTW): ya no hay «IPERC vigente» que medir por trabajo.'),
  (gen_random_uuid(), 'desechos_peligrosos_kg_mes', 'ambiental', 'Desechos peligrosos generados (mes actual)', 'kg', 'menor_mejor', 9, true, NULL),
  (gen_random_uuid(), 'reciclaje_pct', 'ambiental', '% de reciclaje (peso en contenedor azul)', '%', 'mayor_mejor', 10, true, NULL),
  (gen_random_uuid(), 'derrames_trimestre', 'ambiental', 'Derrames en el trimestre actual', 'eventos', 'menor_mejor', 11, true, NULL),
  (gen_random_uuid(), 'derrames_volumen_barriles_year', 'ambiental', 'Volumen total derramado (año)', 'barriles', 'menor_mejor', 12, true, NULL),
  (gen_random_uuid(), 'stop_per_capita', 'cultura_preventiva', 'Tarjetas STOP per cápita', 'tarjetas/persona', 'mayor_mejor', 13, true, NULL),
  (gen_random_uuid(), 'stop_participacion_pct', 'cultura_preventiva', '% de participación en programa STOP', '%', 'mayor_mejor', 14, false, 'Requiere la nómina de personal: no existe un módulo de personal en el sistema.'),
  (gen_random_uuid(), 'swa_eventos', 'cultura_preventiva', 'Eventos de Stop Work Authority (indicador positivo)', 'eventos', 'mayor_mejor', 15, true, NULL),
  (gen_random_uuid(), 'personal_capacitado_pct', 'cultura_preventiva', '% de personal capacitado en procedimientos HSE', '%', 'mayor_mejor', 16, false, 'Requiere un módulo de capacitación: no existe en el sistema.');

-- los indicadores son del sistema: la aplicación solo los lee
REVOKE INSERT, UPDATE, DELETE ON "kpi_indicador" FROM app_qhse;

CREATE TABLE "kpi_meta" (
    "id" UUID NOT NULL,
    "indicador_id" UUID NOT NULL,
    "valor" NUMERIC(14,3) NOT NULL,
    "vigente_desde" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    CONSTRAINT "kpi_meta_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "kpi_meta_indicador_fkey" FOREIGN KEY ("indicador_id") REFERENCES "kpi_indicador" ("id"),
    CONSTRAINT "kpi_meta_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "kpi_meta_valor_check" CHECK ("valor" >= 0),
    CONSTRAINT "kpi_meta_vigencia_key" UNIQUE ("indicador_id", "vigente_desde")
);
-- la meta vigente de un indicador es la más reciente
CREATE INDEX "kpi_meta_vigente_idx" ON "kpi_meta" ("indicador_id", "vigente_desde" DESC);
REVOKE UPDATE, DELETE ON "kpi_meta" FROM app_qhse;
COMMENT ON TABLE "kpi_meta" IS 'Meta de un indicador del tablero HSE. Es historia: una meta nueva reemplaza a la anterior (la vigente es la más reciente) y no se edita ni se borra.';
