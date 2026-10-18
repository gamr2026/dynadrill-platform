-- FCR (Fishing, Completion & Remedial): pasos del servicio con sus dos entradas (venta y servicios), catálogos fijos, ticket (uno por
-- pedido), equipo asignado y requisitos por paso. Estándar de calidad: documentacion/modulos/01-REGLAS-DE-COORDINACION.md.
-- Depende de `catalogos` e `identidad` (FK reales a sus tablas maestras) y, en los tramos siguientes, de `inventario`.

CREATE TYPE "macro_estado" AS ENUM ('pendiente', 'en_proceso', 'esperando_aprobacion', 'aprobado', 'rechazado');
CREATE TYPE "origen_cambio" AS ENUM ('manual', 'sistema');
CREATE TYPE "tipo_ot" AS ENUM ('venta', 'servicio');
CREATE TYPE "estado_requisito" AS ENUM ('pendiente', 'cumplido');
CREATE TYPE "origen_cumplimiento" AS ENUM ('sistema', 'evento', 'manual_temporal');
CREATE TYPE "ambito_requisito" AS ENUM ('ticket', 'unidad', 'operador');
CREATE TYPE "modulo_dueno" AS ENUM ('fcr', 'qhse', 'flota');
CREATE TYPE "rol_asignado" AS ENUM ('supervisor', 'operador');

-- Lectura de las tablas maestras (solo lo necesario; de `identidad.usuario` nunca la clave ni los datos de acceso)
GRANT USAGE ON SCHEMA catalogos, identidad TO app_operaciones;
GRANT SELECT ON catalogos.cliente, catalogos.campo, catalogos.bloque, catalogos.pozo, catalogos.taladro,
  catalogos.vehiculo, catalogos.tipo_vehiculo TO app_operaciones;
GRANT SELECT (id, nombre, email, activo, rol_id) ON identidad.usuario TO app_operaciones;
GRANT SELECT (id, codigo, nombre) ON identidad.rol TO app_operaciones;

-- ---------------------------------------------------------------------------------------------------------------
-- Pasos, transiciones y entradas
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE "paso" (
    "codigo" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "macro" "macro_estado" NOT NULL,
    "orden" INTEGER NOT NULL,
    "terminal" BOOLEAN NOT NULL DEFAULT false,
    "requiere_equipo" BOOLEAN NOT NULL DEFAULT true,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "paso_pkey" PRIMARY KEY ("codigo"),
    CONSTRAINT "paso_orden_key" UNIQUE ("orden"),
    CONSTRAINT "paso_orden_check" CHECK ("orden" > 0)
);
COMMENT ON TABLE "paso" IS 'Pasos del servicio de FCR: entrada VENTA, entrada SERVICIOS y tronco común. Los dos recorridos se distinguen por `entrada_ot` y `transicion`.';
COMMENT ON COLUMN "paso"."requiere_equipo" IS 'Verdadero: solo el equipo asignado al ticket (o quien coordina) actúa en el paso. Falso: cualquier cuenta del rol (arranque del ticket y Bodega).';

-- los roles son códigos de `identidad.rol` (FK al código único)
CREATE TABLE "paso_rol" (
    "paso_codigo" TEXT NOT NULL,
    "rol_codigo" TEXT NOT NULL,
    CONSTRAINT "paso_rol_pkey" PRIMARY KEY ("paso_codigo", "rol_codigo"),
    CONSTRAINT "paso_rol_paso_fkey" FOREIGN KEY ("paso_codigo") REFERENCES "paso" ("codigo"),
    CONSTRAINT "paso_rol_rol_fkey" FOREIGN KEY ("rol_codigo") REFERENCES identidad.rol ("codigo")
);

CREATE TABLE "entrada_ot" (
    "tipo_ot" "tipo_ot" NOT NULL,
    "paso_codigo" TEXT NOT NULL,
    CONSTRAINT "entrada_ot_pkey" PRIMARY KEY ("tipo_ot"),
    CONSTRAINT "entrada_ot_paso_fkey" FOREIGN KEY ("paso_codigo") REFERENCES "paso" ("codigo")
);
COMMENT ON TABLE "entrada_ot" IS 'Paso en el que nace el ticket según el tipo de OT del pedido (venta o servicio).';

CREATE TABLE "transicion" (
    "id" UUID NOT NULL,
    "origen_codigo" TEXT NOT NULL,
    "destino_codigo" TEXT NOT NULL,
    "requiere_motivo" BOOLEAN NOT NULL DEFAULT false,
    "exige_requisitos" BOOLEAN NOT NULL DEFAULT true,
    "activa" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "transicion_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "transicion_origen_fkey" FOREIGN KEY ("origen_codigo") REFERENCES "paso" ("codigo"),
    CONSTRAINT "transicion_destino_fkey" FOREIGN KEY ("destino_codigo") REFERENCES "paso" ("codigo"),
    CONSTRAINT "transicion_distinta_check" CHECK ("origen_codigo" <> "destino_codigo")
);
CREATE UNIQUE INDEX "transicion_origen_destino_key" ON "transicion" ("origen_codigo", "destino_codigo");
COMMENT ON COLUMN "transicion"."exige_requisitos" IS 'Falso en los rechazos (vuelven a un paso anterior): no se exige que el paso de origen esté completo.';

-- ---------------------------------------------------------------------------------------------------------------
-- Requisitos por paso
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE "requisito" (
    "codigo" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "descripcion" TEXT,
    "ambito" "ambito_requisito" NOT NULL,
    "modulo" "modulo_dueno" NOT NULL,
    "tipo_ot" "tipo_ot",
    "activo" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "requisito_pkey" PRIMARY KEY ("codigo")
);
COMMENT ON COLUMN "requisito"."tipo_ot" IS 'Si no es nulo, el requisito solo aplica a los tickets de ese tipo de OT.';

CREATE TABLE "paso_requisito" (
    "paso_codigo" TEXT NOT NULL,
    "requisito_codigo" TEXT NOT NULL,
    CONSTRAINT "paso_requisito_pkey" PRIMARY KEY ("paso_codigo", "requisito_codigo"),
    CONSTRAINT "paso_requisito_paso_fkey" FOREIGN KEY ("paso_codigo") REFERENCES "paso" ("codigo"),
    CONSTRAINT "paso_requisito_requisito_fkey" FOREIGN KEY ("requisito_codigo") REFERENCES "requisito" ("codigo")
);
COMMENT ON TABLE "paso_requisito" IS 'Requisitos que deben estar cumplidos para SALIR de un paso.';

-- ---------------------------------------------------------------------------------------------------------------
-- Catálogos fijos del negocio
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE "tipo_operador" (
    "id" UUID NOT NULL,
    "codigo" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "orden" INTEGER NOT NULL,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    CONSTRAINT "tipo_operador_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "tipo_operador_codigo_key" UNIQUE ("codigo"),
    CONSTRAINT "tipo_operador_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "tipo_operador_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id")
);
CREATE TABLE "tipo_completacion" (
    "id" UUID NOT NULL,
    "codigo" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "orden" INTEGER NOT NULL,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    CONSTRAINT "tipo_completacion_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "tipo_completacion_codigo_key" UNIQUE ("codigo"),
    CONSTRAINT "tipo_completacion_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "tipo_completacion_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id")
);
CREATE TABLE "tipo_trabajo" (
    "id" UUID NOT NULL,
    "codigo" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "orden" INTEGER NOT NULL,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    CONSTRAINT "tipo_trabajo_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "tipo_trabajo_codigo_key" UNIQUE ("codigo"),
    CONSTRAINT "tipo_trabajo_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "tipo_trabajo_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id")
);
CREATE TABLE "tipo_picker" (
    "id" UUID NOT NULL,
    "codigo" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "orden" INTEGER NOT NULL,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    CONSTRAINT "tipo_picker_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "tipo_picker_codigo_key" UNIQUE ("codigo"),
    CONSTRAINT "tipo_picker_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "tipo_picker_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id")
);
COMMENT ON TABLE "tipo_operador" IS 'Quién repara e inspecciona en la entrada SERVICIOS (mecánico, soldador).';
COMMENT ON TABLE "tipo_completacion" IS 'Tipo de completación de las OT de venta (selectiva, inyección, power oil).';
COMMENT ON TABLE "tipo_trabajo" IS 'Tipo de trabajo de las OT de servicios (fractura, estimulación, evaluación, cemento, picking).';
COMMENT ON TABLE "tipo_picker" IS 'Medida del picker usado en la ejecución.';

-- ---------------------------------------------------------------------------------------------------------------
-- Ticket
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE "ticket" (
    "id" UUID NOT NULL,
    "pedido_id" UUID NOT NULL,
    "pedido_codigo" TEXT NOT NULL,
    "ticket_numero" INTEGER,
    "paso_codigo" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "tipo_ot" "tipo_ot" NOT NULL,
    "tipo_operador_id" UUID,
    "inspector_id" UUID,
    "cliente_id" UUID,
    "campo_id" UUID,
    "bloque_id" UUID,
    "pozo_id" UUID,
    "taladro_id" UUID,
    "rigless" BOOLEAN NOT NULL DEFAULT false,
    "numero_contrato" TEXT,
    "as2_numero" TEXT,
    "fecha_inicio_servicio" DATE,
    "fecha_fin_servicio" DATE,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    CONSTRAINT "ticket_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ticket_pedido_id_key" UNIQUE ("pedido_id"),
    CONSTRAINT "ticket_ticket_numero_key" UNIQUE ("ticket_numero"),
    CONSTRAINT "ticket_paso_fkey" FOREIGN KEY ("paso_codigo") REFERENCES "paso" ("codigo"),
    CONSTRAINT "ticket_tipo_operador_fkey" FOREIGN KEY ("tipo_operador_id") REFERENCES "tipo_operador" ("id"),
    CONSTRAINT "ticket_inspector_fkey" FOREIGN KEY ("inspector_id") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "ticket_cliente_fkey" FOREIGN KEY ("cliente_id") REFERENCES catalogos.cliente ("id"),
    CONSTRAINT "ticket_campo_fkey" FOREIGN KEY ("campo_id") REFERENCES catalogos.campo ("id"),
    CONSTRAINT "ticket_bloque_fkey" FOREIGN KEY ("bloque_id") REFERENCES catalogos.bloque ("id"),
    CONSTRAINT "ticket_pozo_fkey" FOREIGN KEY ("pozo_id") REFERENCES catalogos.pozo ("id"),
    CONSTRAINT "ticket_taladro_fkey" FOREIGN KEY ("taladro_id") REFERENCES catalogos.taladro ("id"),
    CONSTRAINT "ticket_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "ticket_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "ticket_version_check" CHECK ("version" > 0),
    -- el tipo de operador y el inspector son de la entrada SERVICIOS: un ticket de venta nunca los lleva
    CONSTRAINT "ticket_servicios_check" CHECK (("tipo_operador_id" IS NULL AND "inspector_id" IS NULL) OR "tipo_ot" = 'servicio'),
    CONSTRAINT "ticket_fechas_check" CHECK ("fecha_fin_servicio" IS NULL OR "fecha_inicio_servicio" IS NULL OR "fecha_fin_servicio" >= "fecha_inicio_servicio")
);
CREATE INDEX "ticket_paso_codigo_idx" ON "ticket" ("paso_codigo");
CREATE INDEX "ticket_inspector_idx" ON "ticket" ("inspector_id");
COMMENT ON TABLE "ticket" IS 'Ticket de servicio de FCR: uno por pedido de la línea; los nombres de cliente, campo, pozo... salen de los catálogos con JOIN.';
COMMENT ON COLUMN "ticket"."pedido_id" IS 'Pedido de `comercial` (otro contenedor, D1): uuid SIN FK, validado por el evento comercial.pedido.abierto.';
COMMENT ON COLUMN "ticket"."pedido_codigo" IS 'Copia del código del pedido (PED-...) de otro contenedor: la usan la bandeja y los avisos. El código no cambia una vez abierto el pedido.';
COMMENT ON COLUMN "ticket"."ticket_numero" IS 'Número de ticket = el de la prefactura que vendrá, reservado por comercial al abrir el pedido (no es una numeración de FCR).';
COMMENT ON COLUMN "ticket"."tipo_ot" IS 'Lo decide Ventas en el pedido; FCR lo hereda. Define el paso de entrada (`entrada_ot`).';
COMMENT ON COLUMN "ticket"."inspector_id" IS 'Operador FCR que repara e inspecciona las herramientas (solo entrada SERVICIOS).';

CREATE TABLE "ticket_tipo_servicio" (
    "ticket_id" UUID NOT NULL,
    "tipo_codigo" TEXT NOT NULL,
    CONSTRAINT "ticket_tipo_servicio_pkey" PRIMARY KEY ("ticket_id", "tipo_codigo"),
    CONSTRAINT "ticket_tipo_servicio_ticket_fkey" FOREIGN KEY ("ticket_id") REFERENCES "ticket" ("id") ON DELETE CASCADE
);
COMMENT ON COLUMN "ticket_tipo_servicio"."tipo_codigo" IS 'Código del tipo de servicio del catálogo de `comercial` (otro contenedor, D1): sin FK.';

CREATE TABLE "ticket_historial" (
    "id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "paso_anterior" TEXT,
    "paso_nuevo" TEXT NOT NULL,
    "motivo" TEXT,
    "actor_id" UUID,
    "actor_rol" TEXT,
    "origen" "origen_cambio" NOT NULL DEFAULT 'manual',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ticket_historial_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ticket_historial_ticket_fkey" FOREIGN KEY ("ticket_id") REFERENCES "ticket" ("id") ON DELETE CASCADE,
    CONSTRAINT "ticket_historial_anterior_fkey" FOREIGN KEY ("paso_anterior") REFERENCES "paso" ("codigo"),
    CONSTRAINT "ticket_historial_nuevo_fkey" FOREIGN KEY ("paso_nuevo") REFERENCES "paso" ("codigo"),
    CONSTRAINT "ticket_historial_actor_fkey" FOREIGN KEY ("actor_id") REFERENCES identidad.usuario ("id")
);
CREATE INDEX "ticket_historial_ticket_created_idx" ON "ticket_historial" ("ticket_id", "created_at");
-- la historia no se edita ni se borra: un error se corrige con un registro nuevo
REVOKE UPDATE, DELETE ON "ticket_historial" FROM app_operaciones;
COMMENT ON TABLE "ticket_historial" IS 'Seguimiento del ticket: cada cambio de paso con quién lo hizo. Inmutable.';
COMMENT ON COLUMN "ticket_historial"."actor_rol" IS 'Rol con el que actuó (dato histórico: la cuenta puede cambiar de rol después).';

-- ---------------------------------------------------------------------------------------------------------------
-- Equipo asignado
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE "ticket_unidad" (
    "ticket_id" UUID NOT NULL,
    "vehiculo_id" UUID NOT NULL,
    "asignado_por" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ticket_unidad_pkey" PRIMARY KEY ("ticket_id", "vehiculo_id"),
    CONSTRAINT "ticket_unidad_ticket_fkey" FOREIGN KEY ("ticket_id") REFERENCES "ticket" ("id") ON DELETE CASCADE,
    CONSTRAINT "ticket_unidad_vehiculo_fkey" FOREIGN KEY ("vehiculo_id") REFERENCES catalogos.vehiculo ("id"),
    CONSTRAINT "ticket_unidad_asignado_por_fkey" FOREIGN KEY ("asignado_por") REFERENCES identidad.usuario ("id")
);

CREATE TABLE "ticket_persona" (
    "ticket_id" UUID NOT NULL,
    "usuario_id" UUID NOT NULL,
    "rol" "rol_asignado" NOT NULL,
    "vehiculo_id" UUID,
    "asignado_por" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ticket_persona_pkey" PRIMARY KEY ("ticket_id", "usuario_id"),
    CONSTRAINT "ticket_persona_ticket_fkey" FOREIGN KEY ("ticket_id") REFERENCES "ticket" ("id") ON DELETE CASCADE,
    CONSTRAINT "ticket_persona_usuario_fkey" FOREIGN KEY ("usuario_id") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "ticket_persona_asignado_por_fkey" FOREIGN KEY ("asignado_por") REFERENCES identidad.usuario ("id"),
    -- la unidad que lleva un operador debe estar asignada al mismo ticket
    CONSTRAINT "ticket_persona_unidad_fkey" FOREIGN KEY ("ticket_id", "vehiculo_id") REFERENCES "ticket_unidad" ("ticket_id", "vehiculo_id"),
    -- solo los operadores llevan unidad
    CONSTRAINT "ticket_persona_unidad_check" CHECK ("vehiculo_id" IS NULL OR "rol" = 'operador')
);
CREATE INDEX "ticket_persona_usuario_idx" ON "ticket_persona" ("usuario_id");
CREATE INDEX "ticket_persona_vehiculo_idx" ON "ticket_persona" ("vehiculo_id");
-- un solo supervisor por ticket
CREATE UNIQUE INDEX "ticket_persona_supervisor_key" ON "ticket_persona" ("ticket_id") WHERE "rol" = 'supervisor';
-- reasignar reemplaza lo anterior (borra y vuelve a crear): el rastro queda en el historial del ticket
GRANT DELETE ON "ticket_persona", "ticket_unidad" TO app_operaciones;
COMMENT ON TABLE "ticket_persona" IS 'Equipo del ticket: un supervisor y los operadores (cada uno con su unidad, si el servicio lleva). Solo ellos actúan en los pasos que requieren equipo.';

-- ---------------------------------------------------------------------------------------------------------------
-- Requisitos del ticket
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE "ticket_requisito" (
    "id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "requisito_codigo" TEXT NOT NULL,
    "vehiculo_id" UUID,
    "usuario_id" UUID,
    "estado" "estado_requisito" NOT NULL DEFAULT 'pendiente',
    "cumplido_at" TIMESTAMPTZ(6),
    "cumplido_por" UUID,
    "origen" "origen_cumplimiento",
    "motivo" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ticket_requisito_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ticket_requisito_ticket_fkey" FOREIGN KEY ("ticket_id") REFERENCES "ticket" ("id") ON DELETE CASCADE,
    CONSTRAINT "ticket_requisito_requisito_fkey" FOREIGN KEY ("requisito_codigo") REFERENCES "requisito" ("codigo"),
    -- un requisito es del ticket, de una unidad o de un operador asignados (nunca de los dos a la vez)
    CONSTRAINT "ticket_requisito_unidad_fkey" FOREIGN KEY ("ticket_id", "vehiculo_id") REFERENCES "ticket_unidad" ("ticket_id", "vehiculo_id"),
    CONSTRAINT "ticket_requisito_persona_fkey" FOREIGN KEY ("ticket_id", "usuario_id") REFERENCES "ticket_persona" ("ticket_id", "usuario_id"),
    CONSTRAINT "ticket_requisito_vehiculo_fkey" FOREIGN KEY ("vehiculo_id") REFERENCES catalogos.vehiculo ("id"),
    CONSTRAINT "ticket_requisito_usuario_fkey" FOREIGN KEY ("usuario_id") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "ticket_requisito_cumplido_por_fkey" FOREIGN KEY ("cumplido_por") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "ticket_requisito_ambito_check" CHECK ("vehiculo_id" IS NULL OR "usuario_id" IS NULL),
    CONSTRAINT "ticket_requisito_cumplido_check" CHECK (("estado" = 'cumplido') = ("cumplido_at" IS NOT NULL)),
    CONSTRAINT "ticket_requisito_manual_check" CHECK ("origen" IS DISTINCT FROM 'manual_temporal' OR length(btrim(coalesce("motivo", ''))) > 0)
);
-- un solo registro por requisito, ticket y unidad u operador (los nulos cuentan como iguales)
CREATE UNIQUE INDEX "ticket_requisito_unico_key" ON "ticket_requisito" ("ticket_id", "requisito_codigo", "vehiculo_id", "usuario_id") NULLS NOT DISTINCT;
CREATE INDEX "ticket_requisito_ticket_estado_idx" ON "ticket_requisito" ("ticket_id", "estado");
COMMENT ON TABLE "ticket_requisito" IS 'Estado de cada requisito de un ticket (del ticket, de una unidad o de un operador). Se cumple desde FCR, por un evento de otro módulo o con el puente temporal (con motivo).';
