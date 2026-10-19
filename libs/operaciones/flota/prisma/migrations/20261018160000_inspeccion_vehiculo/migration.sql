-- Flota, tramo F3: inspección de vehículos (DYN-SGI-RE-068).
-- Una inspección es un documento firmado: no se edita ni se borra (solo se anula con motivo). Los ítems del formato son un
-- catálogo y sus respuestas son filas; la descripción del vehículo (marca, modelo, placa...), los documentos del vehículo y el
-- kilometraje NO se copian: salen de `unidad`/`catalogos.vehiculo` y de la lectura de odómetro que la propia inspección registra.
-- Depende de `pumping.ticket` (FK real, mismo contenedor): se aplica después de `db:migrate:pumping`.

CREATE TYPE "momento_inspeccion" AS ENUM ('salida', 'llegada');
CREATE TYPE "resultado_checklist" AS ENUM ('cumple', 'no_cumple', 'no_aplica');
CREATE TYPE "seccion_inspeccion" AS ENUM ('vehiculo', 'equipo');
CREATE TYPE "decision_revision" AS ENUM ('aprobada', 'rechazada');

GRANT USAGE ON SCHEMA pumping TO app_operaciones;
GRANT SELECT (id) ON pumping.ticket TO app_operaciones;

-- Los 24 ítems del vehículo y los 6 del equipo. `bloquea_si_no_cumple` es la Nota 1 del formato (cinturón de seguridad): no se
-- decide comparando el texto de la etiqueta.
CREATE TABLE "item_inspeccion_vehiculo" (
    "id" UUID NOT NULL,
    "codigo" TEXT NOT NULL,
    "seccion" "seccion_inspeccion" NOT NULL,
    "orden" SMALLINT NOT NULL,
    "etiqueta" TEXT NOT NULL,
    "bloquea_si_no_cumple" BOOLEAN NOT NULL DEFAULT false,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    CONSTRAINT "item_inspeccion_vehiculo_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "item_inspeccion_vehiculo_codigo_key" ON "item_inspeccion_vehiculo"("codigo");
CREATE UNIQUE INDEX "item_inspeccion_vehiculo_seccion_orden_key" ON "item_inspeccion_vehiculo"("seccion", "orden");
ALTER TABLE "item_inspeccion_vehiculo"
  ADD CONSTRAINT "item_inspeccion_vehiculo_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
  ADD CONSTRAINT "item_inspeccion_vehiculo_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id");

-- Caso de inspección: una unidad de transporte asignada a un ticket de Pumping. Lo abre el consumidor de
-- `operaciones.pumping.asignacion_realizada`. Su estado (pendiente, por aprobar, aprobada) se calcula con las inspecciones y sus
-- revisiones: no se guarda.
CREATE TABLE "inspeccion_caso" (
    "id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "unidad_id" UUID NOT NULL,
    "operador_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    CONSTRAINT "inspeccion_caso_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "inspeccion_caso_ticket_id_unidad_id_key" ON "inspeccion_caso"("ticket_id", "unidad_id");
CREATE UNIQUE INDEX "inspeccion_caso_id_unidad_id_key" ON "inspeccion_caso"("id", "unidad_id");
CREATE INDEX "inspeccion_caso_operador_id_idx" ON "inspeccion_caso"("operador_id");
ALTER TABLE "inspeccion_caso"
  ADD CONSTRAINT "inspeccion_caso_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES pumping.ticket ("id"),
  ADD CONSTRAINT "inspeccion_caso_unidad_id_fkey" FOREIGN KEY ("unidad_id") REFERENCES "unidad" ("id"),
  ADD CONSTRAINT "inspeccion_caso_operador_id_fkey" FOREIGN KEY ("operador_id") REFERENCES identidad.usuario ("id"),
  ADD CONSTRAINT "inspeccion_caso_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
  ADD CONSTRAINT "inspeccion_caso_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id");
COMMENT ON COLUMN "inspeccion_caso"."operador_id" IS 'Operador al que Pumping emparejó con la unidad en la asignación (cuenta de identidad).';

CREATE TABLE "inspeccion_vehiculo" (
    "id" UUID NOT NULL,
    "caso_id" UUID,
    "unidad_id" UUID NOT NULL,
    "momento" "momento_inspeccion" NOT NULL DEFAULT 'salida',
    "fecha" TIMESTAMPTZ(6) NOT NULL,
    "punto_partida" TEXT NOT NULL,
    "destino" TEXT,
    "conductor_id" UUID NOT NULL,
    "observaciones" TEXT,
    "anulada_at" TIMESTAMPTZ(6),
    "anulada_por" UUID,
    "anulacion_motivo" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    CONSTRAINT "inspeccion_vehiculo_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "inspeccion_vehiculo_anulacion_check" CHECK (
      ("anulada_at" IS NULL AND "anulada_por" IS NULL AND "anulacion_motivo" IS NULL)
      OR ("anulada_at" IS NOT NULL AND "anulada_por" IS NOT NULL AND char_length(btrim("anulacion_motivo")) >= 5)
    )
);
CREATE UNIQUE INDEX "inspeccion_vehiculo_id_unidad_id_key" ON "inspeccion_vehiculo"("id", "unidad_id");
-- Una sola inspección vigente por caso y momento (la anulada deja el lugar libre para repetirla).
CREATE UNIQUE INDEX "inspeccion_vehiculo_caso_momento_vigente_key"
  ON "inspeccion_vehiculo"("caso_id", "momento") WHERE "caso_id" IS NOT NULL AND "anulada_at" IS NULL;
CREATE INDEX "inspeccion_vehiculo_unidad_id_fecha_idx" ON "inspeccion_vehiculo"("unidad_id", "fecha" DESC);
CREATE INDEX "inspeccion_vehiculo_conductor_id_idx" ON "inspeccion_vehiculo"("conductor_id");
ALTER TABLE "inspeccion_vehiculo"
  ADD CONSTRAINT "inspeccion_vehiculo_unidad_id_fkey" FOREIGN KEY ("unidad_id") REFERENCES "unidad" ("id"),
  -- El caso y la inspección deben hablar de la misma unidad.
  ADD CONSTRAINT "inspeccion_vehiculo_caso_fkey" FOREIGN KEY ("caso_id", "unidad_id") REFERENCES "inspeccion_caso" ("id", "unidad_id"),
  ADD CONSTRAINT "inspeccion_vehiculo_conductor_id_fkey" FOREIGN KEY ("conductor_id") REFERENCES identidad.usuario ("id"),
  ADD CONSTRAINT "inspeccion_vehiculo_anulada_por_fkey" FOREIGN KEY ("anulada_por") REFERENCES identidad.usuario ("id"),
  ADD CONSTRAINT "inspeccion_vehiculo_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id");
COMMENT ON COLUMN "inspeccion_vehiculo"."punto_partida" IS 'Texto del formato (se escribe a mano en la hoja); no hay un catálogo de rutas. Consulta a Dynadrill en plan-flota.';
COMMENT ON COLUMN "inspeccion_vehiculo"."conductor_id" IS 'Quien conduce y firma la inspección; sus documentos deben estar vigentes al guardarla (regla del servicio, sobre conductor_permiso).';

CREATE TABLE "inspeccion_vehiculo_resultado" (
    "inspeccion_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "resultado" "resultado_checklist" NOT NULL,
    CONSTRAINT "inspeccion_vehiculo_resultado_pkey" PRIMARY KEY ("inspeccion_id", "item_id")
);
ALTER TABLE "inspeccion_vehiculo_resultado"
  ADD CONSTRAINT "inspeccion_vehiculo_resultado_inspeccion_id_fkey" FOREIGN KEY ("inspeccion_id") REFERENCES "inspeccion_vehiculo" ("id"),
  ADD CONSTRAINT "inspeccion_vehiculo_resultado_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "item_inspeccion_vehiculo" ("id");

-- Revisión del Supervisor (aprueba o rechaza). Se agrega, nunca se cambia: vale la última de cada inspección.
CREATE TABLE "inspeccion_vehiculo_revision" (
    "id" UUID NOT NULL,
    "inspeccion_id" UUID NOT NULL,
    "decision" "decision_revision" NOT NULL,
    "motivo" TEXT,
    "revisada_por" UUID NOT NULL,
    "revisada_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "inspeccion_vehiculo_revision_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "inspeccion_vehiculo_revision_motivo_check" CHECK ("decision" = 'aprobada' OR char_length(btrim("motivo")) >= 5)
);
CREATE INDEX "inspeccion_vehiculo_revision_inspeccion_id_revisada_at_idx"
  ON "inspeccion_vehiculo_revision"("inspeccion_id", "revisada_at" DESC);
ALTER TABLE "inspeccion_vehiculo_revision"
  ADD CONSTRAINT "inspeccion_vehiculo_revision_inspeccion_id_fkey" FOREIGN KEY ("inspeccion_id") REFERENCES "inspeccion_vehiculo" ("id"),
  ADD CONSTRAINT "inspeccion_vehiculo_revision_revisada_por_fkey" FOREIGN KEY ("revisada_por") REFERENCES identidad.usuario ("id");

-- La lectura de odómetro que registra la inspección: FK por origen (no un id suelto) y un CHECK de que solo las de origen
-- `inspeccion` la lleven.
ALTER TABLE "unidad_lectura" ADD COLUMN "inspeccion_id" UUID;
CREATE UNIQUE INDEX "unidad_lectura_inspeccion_id_key" ON "unidad_lectura"("inspeccion_id") WHERE "inspeccion_id" IS NOT NULL;
ALTER TABLE "unidad_lectura"
  ADD CONSTRAINT "unidad_lectura_inspeccion_id_fkey" FOREIGN KEY ("inspeccion_id") REFERENCES "inspeccion_vehiculo" ("id"),
  ADD CONSTRAINT "unidad_lectura_origen_check" CHECK (("fuente" = 'inspeccion') = ("inspeccion_id" IS NOT NULL));
COMMENT ON COLUMN "unidad_lectura"."fuente" IS 'Origen de la lectura. inspeccion_id (FK) acompaña a la fuente inspeccion; las de reporte de unidad se agregan con su propia FK cuando Mantenimiento la pida.';

-- Reglas que la base garantiza al revisar una inspección:
--  * no se revisa una inspección anulada;
--  * la Nota 1 del formato: no se aprueba si un ítem que bloquea quedó en «No cumple».
CREATE FUNCTION "inspeccion_vehiculo_revision_reglas"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "inspeccion_vehiculo" i WHERE i."id" = NEW."inspeccion_id" AND i."anulada_at" IS NOT NULL) THEN
    RAISE EXCEPTION 'No se puede revisar una inspección anulada' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."decision" = 'aprobada' AND EXISTS (
       SELECT 1
         FROM "inspeccion_vehiculo_resultado" r
         JOIN "item_inspeccion_vehiculo" it ON it."id" = r."item_id"
        WHERE r."inspeccion_id" = NEW."inspeccion_id" AND r."resultado" = 'no_cumple' AND it."bloquea_si_no_cumple"
     ) THEN
    RAISE EXCEPTION 'Un ítem que impide usar el vehículo (Nota 1) está en No cumple: la inspección no se puede aprobar'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "inspeccion_vehiculo_revision_reglas_trg" BEFORE INSERT ON "inspeccion_vehiculo_revision"
  FOR EACH ROW EXECUTE FUNCTION "inspeccion_vehiculo_revision_reglas"();

-- La anulación es definitiva: una inspección anulada no vuelve a estar vigente ni cambia su motivo.
CREATE FUNCTION "inspeccion_vehiculo_anulacion_definitiva"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."anulada_at" IS NOT NULL THEN
    RAISE EXCEPTION 'La inspección ya está anulada' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "inspeccion_vehiculo_anulacion_definitiva_trg" BEFORE UPDATE ON "inspeccion_vehiculo"
  FOR EACH ROW EXECUTE FUNCTION "inspeccion_vehiculo_anulacion_definitiva"();

-- Historia inmutable. La inspección solo admite que se le marque la anulación; sus resultados y revisiones no cambian nunca.
REVOKE UPDATE, DELETE ON "inspeccion_vehiculo", "inspeccion_vehiculo_resultado", "inspeccion_vehiculo_revision" FROM app_operaciones;
GRANT UPDATE ("anulada_at", "anulada_por", "anulacion_motivo") ON "inspeccion_vehiculo" TO app_operaciones;
