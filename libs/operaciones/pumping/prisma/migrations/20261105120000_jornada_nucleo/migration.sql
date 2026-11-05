-- Jornadas (etapa 1): una fila por ticket y día del servicio, con la aceptación diaria del Company Man, el día sin operación, el cierre y la
-- reapertura. Ver documentacion/modulos/DISENO-JORNADA-BACKEND.md. Los requisitos por día, el checklist diario y la salida de Ejecución
-- operativa por jornadas son las etapas siguientes: por ahora la jornada no bloquea nada del flujo actual.

CREATE TYPE "pumping"."estado_jornada" AS ENUM ('pendiente', 'abierta', 'sin_operacion', 'cerrada', 'no_aplica');
CREATE TYPE "pumping"."accion_jornada" AS ENUM ('abierta', 'sin_operacion', 'cerrada', 'reabierta', 'no_aplica');

-- ---------------------------------------------------------------------------------------------------------------
-- Catálogo: motivos de un día sin operación
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE "pumping"."cat_motivo_sin_operacion" (
    "id" UUID NOT NULL,
    "codigo" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "orden" SMALLINT NOT NULL DEFAULT 0,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "cat_motivo_sin_operacion_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "cat_motivo_sin_operacion_textos_check" CHECK (length(btrim("codigo")) > 0 AND length(btrim("nombre")) > 0)
);
CREATE UNIQUE INDEX "cat_motivo_sin_operacion_codigo_key" ON "pumping"."cat_motivo_sin_operacion" ("codigo");
COMMENT ON TABLE "pumping"."cat_motivo_sin_operacion" IS 'Motivos para registrar un día sin operación dentro del rango de un servicio (el detalle va en texto libre en la jornada).';

INSERT INTO "pumping"."cat_motivo_sin_operacion" ("id", "codigo", "nombre", "orden") VALUES
  (gen_random_uuid(), 'clima', 'Lluvia o condiciones climáticas', 1),
  (gen_random_uuid(), 'espera_cliente', 'Espera de cliente', 2),
  (gen_random_uuid(), 'falla_equipo', 'Falla de equipo', 3),
  (gen_random_uuid(), 'orden_cliente', 'Orden del cliente', 4),
  (gen_random_uuid(), 'otro', 'Otro', 5);

-- ---------------------------------------------------------------------------------------------------------------
-- Jornada: un día de operación de un ticket
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE "pumping"."ticket_jornada" (
    "id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "fecha" DATE NOT NULL,
    "numero" SMALLINT NOT NULL,
    "estado" "pumping"."estado_jornada" NOT NULL DEFAULT 'pendiente',
    "company_man_acepto_at" TIMESTAMPTZ(6),
    "company_man_acepto_por" UUID,
    "sin_operacion_motivo_id" UUID,
    "sin_operacion_detalle" TEXT,
    "sin_operacion_at" TIMESTAMPTZ(6),
    "sin_operacion_por" UUID,
    "cerrada_at" TIMESTAMPTZ(6),
    "cerrada_por" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ticket_jornada_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ticket_jornada_ticket_fkey" FOREIGN KEY ("ticket_id") REFERENCES "pumping"."ticket" ("id") ON DELETE CASCADE,
    CONSTRAINT "ticket_jornada_motivo_fkey" FOREIGN KEY ("sin_operacion_motivo_id") REFERENCES "pumping"."cat_motivo_sin_operacion" ("id"),
    CONSTRAINT "ticket_jornada_company_man_acepto_por_fkey" FOREIGN KEY ("company_man_acepto_por") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "ticket_jornada_sin_operacion_por_fkey" FOREIGN KEY ("sin_operacion_por") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "ticket_jornada_cerrada_por_fkey" FOREIGN KEY ("cerrada_por") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "ticket_jornada_numero_check" CHECK ("numero" > 0),
    -- la aceptación del Company Man se guarda con quién la marcó y cuándo (las dos cosas o ninguna)
    CONSTRAINT "ticket_jornada_company_man_check" CHECK (("company_man_acepto_at" IS NULL) = ("company_man_acepto_por" IS NULL)),
    -- un día sin operación lleva siempre motivo, detalle, quién y cuándo; ninguna otra jornada los lleva
    CONSTRAINT "ticket_jornada_sin_operacion_todo_o_nada_check" CHECK (
      ("sin_operacion_motivo_id" IS NULL) = ("sin_operacion_detalle" IS NULL)
      AND ("sin_operacion_motivo_id" IS NULL) = ("sin_operacion_at" IS NULL)
      AND ("sin_operacion_motivo_id" IS NULL) = ("sin_operacion_por" IS NULL)
    ),
    CONSTRAINT "ticket_jornada_sin_operacion_estado_check" CHECK (("estado" = 'sin_operacion') = ("sin_operacion_motivo_id" IS NOT NULL)),
    CONSTRAINT "ticket_jornada_sin_operacion_detalle_check" CHECK ("sin_operacion_detalle" IS NULL OR length(btrim("sin_operacion_detalle")) >= 3),
    -- el cierre se guarda con quién y cuándo; solo una jornada cerrada lo lleva
    CONSTRAINT "ticket_jornada_cierre_check" CHECK (("cerrada_at" IS NULL) = ("cerrada_por" IS NULL)),
    CONSTRAINT "ticket_jornada_cierre_estado_check" CHECK (("estado" = 'cerrada') = ("cerrada_at" IS NOT NULL)),
    -- una jornada abierta tiene la aceptación del Company Man (es lo mínimo para abrirla; las etapas siguientes agregan más requisitos)
    CONSTRAINT "ticket_jornada_abierta_check" CHECK ("estado" <> 'abierta' OR "company_man_acepto_at" IS NOT NULL)
);
CREATE UNIQUE INDEX "ticket_jornada_dia_key" ON "pumping"."ticket_jornada" ("ticket_id", "fecha");
CREATE INDEX "ticket_jornada_sin_operacion_motivo_id_idx" ON "pumping"."ticket_jornada" ("sin_operacion_motivo_id");
GRANT SELECT, INSERT, UPDATE ON "pumping"."ticket_jornada" TO app_operaciones;
COMMENT ON TABLE "pumping"."ticket_jornada" IS 'Un día de operación de un ticket de Pumping (una fila por fecha del rango del servicio). Guarda solo lo que no se puede deducir: «hoy», «bloqueada» y «con pendientes» se calculan al leer.';
COMMENT ON COLUMN "pumping"."ticket_jornada"."numero" IS 'Día N del servicio (1..M); una jornada «no aplica» conserva el número que tenía.';
COMMENT ON COLUMN "pumping"."ticket_jornada"."company_man_acepto_at" IS 'Cuándo el Supervisor marcó que el Company Man aceptó trabajar ese día (casilla, el aviso se da de palabra).';

-- ---------------------------------------------------------------------------------------------------------------
-- Bitácora de la jornada: solo se agrega (no se concede UPDATE ni DELETE)
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE "pumping"."ticket_jornada_historial" (
    "id" UUID NOT NULL,
    "jornada_id" UUID NOT NULL,
    "accion" "pumping"."accion_jornada" NOT NULL,
    "motivo" TEXT,
    "actor_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ticket_jornada_historial_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ticket_jornada_historial_jornada_fkey" FOREIGN KEY ("jornada_id") REFERENCES "pumping"."ticket_jornada" ("id") ON DELETE CASCADE,
    CONSTRAINT "ticket_jornada_historial_actor_fkey" FOREIGN KEY ("actor_id") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "ticket_jornada_historial_motivo_check" CHECK ("motivo" IS NULL OR length(btrim("motivo")) > 0)
);
CREATE INDEX "ticket_jornada_historial_jornada_id_created_at_idx" ON "pumping"."ticket_jornada_historial" ("jornada_id", "created_at");
CREATE INDEX "ticket_jornada_historial_actor_id_idx" ON "pumping"."ticket_jornada_historial" ("actor_id");
GRANT SELECT, INSERT ON "pumping"."ticket_jornada_historial" TO app_operaciones;
COMMENT ON TABLE "pumping"."ticket_jornada_historial" IS 'Qué se hizo a cada jornada (abrir, sin operación, cerrar, reabrir) y quién, con el motivo cuando lo hay. Solo se agrega.';
