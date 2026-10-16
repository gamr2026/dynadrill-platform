-- CreateTable
CREATE TABLE "proceso_estado" (
    "id" UUID NOT NULL,
    "proceso" TEXT NOT NULL,
    "codigo" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "macro_estado" TEXT NOT NULL,
    "orden" INTEGER NOT NULL DEFAULT 0,
    "rol_responsable" TEXT,
    "terminal" BOOLEAN NOT NULL DEFAULT false,
    "activo" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "proceso_estado_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "proceso_transicion" (
    "id" UUID NOT NULL,
    "proceso" TEXT NOT NULL,
    "estado_origen" TEXT NOT NULL,
    "estado_destino" TEXT NOT NULL,
    "permiso" TEXT,
    "requiere_motivo" BOOLEAN NOT NULL DEFAULT false,
    "automatica" BOOLEAN NOT NULL DEFAULT false,
    "evento_disparador" TEXT,
    "regla" TEXT,
    "activa" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "proceso_transicion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "proceso_historial" (
    "id" UUID NOT NULL,
    "proceso" TEXT NOT NULL,
    "entidad_id" UUID NOT NULL,
    "estado_anterior" TEXT,
    "estado_nuevo" TEXT NOT NULL,
    "macro_estado" TEXT,
    "motivo" TEXT,
    "actor_id" UUID,
    "actor_nombre" TEXT,
    "actor_rol" TEXT,
    "origen" TEXT NOT NULL DEFAULT 'manual',
    "evento_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "proceso_historial_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pedido" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "codigo" TEXT,
    "origen" TEXT NOT NULL,
    "as2_id_pedido_cliente" INTEGER,
    "as2_numero" TEXT,
    "as2_estado" TEXT,
    "as2_fecha" DATE,
    "as2_total" DECIMAL(14,2),
    "as2_descuento" DECIMAL(14,2),
    "as2_impuesto" DECIMAL(14,2),
    "as2_descripcion" TEXT,
    "as2_sync_estado" TEXT NOT NULL DEFAULT 'no_aplica',
    "as2_vinculo_metodo" TEXT,
    "as2_sincronizado_at" TIMESTAMPTZ(6),
    "cliente_id" UUID,
    "cliente_nombre" TEXT,
    "cliente_ruc" TEXT,
    "subcliente" TEXT,
    "linea_servicio" TEXT,
    "tipo_ot" TEXT,
    "campo_id" UUID,
    "campo_nombre" TEXT,
    "bloque_id" UUID,
    "bloque_nombre" TEXT,
    "pozo_id" UUID,
    "pozo_nombre" TEXT,
    "taladro_id" UUID,
    "taladro_nombre" TEXT,
    "rigless" BOOLEAN NOT NULL DEFAULT false,
    "numero_contrato" TEXT,
    "proceso" TEXT NOT NULL DEFAULT 'pedido',
    "estado" TEXT NOT NULL DEFAULT 'borrador',
    "motivo_anulacion" TEXT,
    "anulado_at" TIMESTAMPTZ(6),
    "agente_comercial_id" UUID,
    "agente_comercial_nombre" TEXT,
    "representante_campo_id" UUID,
    "representante_campo_nombre" TEXT,
    "representante_quito_id" UUID,
    "representante_quito_nombre" TEXT,
    "tecnico_hse_id" UUID,
    "tecnico_hse_nombre" TEXT,
    "analista_facturacion_id" UUID,
    "analista_facturacion_nombre" TEXT,
    "analista_asignado_por" UUID,
    "analista_asignado_at" TIMESTAMPTZ(6),
    "condicion_pago" TEXT,
    "zona" TEXT,
    "bodega" TEXT,
    "solicitud_medio" TEXT,
    "fecha_inicio_servicio" DATE,
    "fecha_fin_servicio" DATE,

    CONSTRAINT "pedido_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pedido_tipo_servicio" (
    "id" UUID NOT NULL,
    "pedido_id" UUID NOT NULL,
    "tipo_servicio" TEXT NOT NULL,

    CONSTRAINT "pedido_tipo_servicio_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pedido_subtipo_servicio" (
    "id" UUID NOT NULL,
    "pedido_id" UUID NOT NULL,
    "subtipo" TEXT NOT NULL,

    CONSTRAINT "pedido_subtipo_servicio_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pedido_item" (
    "id" UUID NOT NULL,
    "pedido_id" UUID NOT NULL,
    "orden" SMALLINT NOT NULL,
    "codigo" TEXT NOT NULL,
    "descripcion" TEXT NOT NULL,
    "unidad" TEXT NOT NULL,
    "cantidad" DECIMAL(12,3) NOT NULL,
    "valor_unitario" DECIMAL(14,2) NOT NULL,
    "descuento_pct" DECIMAL(5,2),
    "es_quimico" BOOLEAN NOT NULL DEFAULT false,
    "es_herramienta" BOOLEAN NOT NULL DEFAULT false,
    "es_movilizacion" BOOLEAN NOT NULL DEFAULT false,
    "origen_item" TEXT NOT NULL DEFAULT 'lista',
    "lista_precios_item_id" UUID,

    CONSTRAINT "pedido_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lista_precios" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "cliente_id" UUID,
    "cliente_nombre" TEXT,
    "numero_contrato" TEXT NOT NULL,
    "vigente_desde" DATE NOT NULL,
    "activa" BOOLEAN NOT NULL DEFAULT true,
    "legacy_id" INTEGER,

    CONSTRAINT "lista_precios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lista_precios_item" (
    "id" UUID NOT NULL,
    "lista_precios_id" UUID NOT NULL,
    "codigo" TEXT NOT NULL,
    "descripcion" TEXT NOT NULL,
    "unidad" TEXT NOT NULL,
    "precio" DECIMAL(14,2) NOT NULL,
    "tipo" TEXT NOT NULL,

    CONSTRAINT "lista_precios_item_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "proceso_estado_proceso_codigo_key" ON "proceso_estado"("proceso", "codigo");

-- CreateIndex
CREATE UNIQUE INDEX "proceso_transicion_proceso_estado_origen_estado_destino_key" ON "proceso_transicion"("proceso", "estado_origen", "estado_destino");

-- CreateIndex
CREATE INDEX "proceso_historial_proceso_entidad_id_created_at_idx" ON "proceso_historial"("proceso", "entidad_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "pedido_codigo_key" ON "pedido"("codigo");

-- CreateIndex
CREATE UNIQUE INDEX "pedido_as2_id_pedido_cliente_key" ON "pedido"("as2_id_pedido_cliente");

-- CreateIndex
CREATE INDEX "pedido_estado_idx" ON "pedido"("estado");

-- CreateIndex
CREATE INDEX "pedido_cliente_id_idx" ON "pedido"("cliente_id");

-- CreateIndex
CREATE INDEX "pedido_linea_servicio_estado_idx" ON "pedido"("linea_servicio", "estado");

-- CreateIndex
CREATE INDEX "pedido_analista_facturacion_id_idx" ON "pedido"("analista_facturacion_id");

-- CreateIndex
CREATE UNIQUE INDEX "pedido_tipo_servicio_pedido_id_tipo_servicio_key" ON "pedido_tipo_servicio"("pedido_id", "tipo_servicio");

-- CreateIndex
CREATE UNIQUE INDEX "pedido_subtipo_servicio_pedido_id_subtipo_key" ON "pedido_subtipo_servicio"("pedido_id", "subtipo");

-- CreateIndex
CREATE UNIQUE INDEX "pedido_item_pedido_id_orden_key" ON "pedido_item"("pedido_id", "orden");

-- CreateIndex
CREATE UNIQUE INDEX "lista_precios_legacy_id_key" ON "lista_precios"("legacy_id");

-- CreateIndex
CREATE INDEX "lista_precios_cliente_id_activa_idx" ON "lista_precios"("cliente_id", "activa");

-- CreateIndex
CREATE UNIQUE INDEX "lista_precios_item_lista_precios_id_codigo_key" ON "lista_precios_item"("lista_precios_id", "codigo");

-- AddForeignKey
ALTER TABLE "proceso_transicion" ADD CONSTRAINT "proceso_transicion_proceso_estado_origen_fkey" FOREIGN KEY ("proceso", "estado_origen") REFERENCES "proceso_estado"("proceso", "codigo") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proceso_transicion" ADD CONSTRAINT "proceso_transicion_proceso_estado_destino_fkey" FOREIGN KEY ("proceso", "estado_destino") REFERENCES "proceso_estado"("proceso", "codigo") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pedido" ADD CONSTRAINT "pedido_proceso_estado_fkey" FOREIGN KEY ("proceso", "estado") REFERENCES "proceso_estado"("proceso", "codigo") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pedido_tipo_servicio" ADD CONSTRAINT "pedido_tipo_servicio_pedido_id_fkey" FOREIGN KEY ("pedido_id") REFERENCES "pedido"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pedido_subtipo_servicio" ADD CONSTRAINT "pedido_subtipo_servicio_pedido_id_fkey" FOREIGN KEY ("pedido_id") REFERENCES "pedido"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pedido_item" ADD CONSTRAINT "pedido_item_pedido_id_fkey" FOREIGN KEY ("pedido_id") REFERENCES "pedido"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pedido_item" ADD CONSTRAINT "pedido_item_lista_precios_item_id_fkey" FOREIGN KEY ("lista_precios_item_id") REFERENCES "lista_precios_item"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lista_precios_item" ADD CONSTRAINT "lista_precios_item_lista_precios_id_fkey" FOREIGN KEY ("lista_precios_id") REFERENCES "lista_precios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Reglas y privilegios que Prisma no expresa --------------------------------------------------------

-- Estados por proceso
ALTER TABLE "proceso_estado" ADD CONSTRAINT "proceso_estado_codigo_check" CHECK ("codigo" ~ '^[a-z][a-z0-9_]*$' AND "proceso" ~ '^[a-z][a-z0-9_]*$');
ALTER TABLE "proceso_estado" ADD CONSTRAINT "proceso_estado_macro_check"
  CHECK ("macro_estado" IN ('borrador', 'pendiente', 'en_proceso', 'esperando_aprobacion', 'aprobado', 'rechazado'));
ALTER TABLE "proceso_transicion" ADD CONSTRAINT "proceso_transicion_distinta_check" CHECK ("estado_origen" <> "estado_destino");

-- El seguimiento es de solo inserción: ni UPDATE ni DELETE para la aplicación.
ALTER TABLE "proceso_historial" ADD CONSTRAINT "proceso_historial_origen_check"
  CHECK ("origen" IN ('manual', 'automatico', 'sincronizacion', 'forzado', 'sistema'));
REVOKE UPDATE ON "proceso_historial" FROM app_comercial;

-- Pedido
ALTER TABLE "pedido" ADD CONSTRAINT "pedido_proceso_check" CHECK ("proceso" = 'pedido');
ALTER TABLE "pedido" ADD CONSTRAINT "pedido_version_check" CHECK ("version" >= 1);
ALTER TABLE "pedido" ADD CONSTRAINT "pedido_origen_check" CHECK ("origen" IN ('portal', 'as2'));
ALTER TABLE "pedido" ADD CONSTRAINT "pedido_as2_origen_check" CHECK ("origen" <> 'as2' OR "as2_id_pedido_cliente" IS NOT NULL);
ALTER TABLE "pedido" ADD CONSTRAINT "pedido_as2_sync_check"
  CHECK ("as2_sync_estado" IN ('no_aplica', 'pendiente_de_crear_en_as2', 'vinculado', 'error'));
ALTER TABLE "pedido" ADD CONSTRAINT "pedido_as2_vinculo_check"
  CHECK ("as2_vinculo_metodo" IS NULL OR "as2_vinculo_metodo" IN ('referencia_en_descripcion', 'manual', 'api'));
ALTER TABLE "pedido" ADD CONSTRAINT "pedido_linea_check" CHECK ("linea_servicio" IS NULL OR "linea_servicio" IN ('fcr', 'pumping'));
ALTER TABLE "pedido" ADD CONSTRAINT "pedido_tipo_ot_check" CHECK ("tipo_ot" IS NULL OR "tipo_ot" IN ('venta', 'servicio'));
ALTER TABLE "pedido" ADD CONSTRAINT "pedido_solicitud_medio_check" CHECK ("solicitud_medio" IS NULL OR "solicitud_medio" IN ('verbal', 'escrita'));
ALTER TABLE "pedido" ADD CONSTRAINT "pedido_rigless_check" CHECK (NOT "rigless" OR "taladro_id" IS NULL);
ALTER TABLE "pedido" ADD CONSTRAINT "pedido_fechas_check"
  CHECK ("fecha_inicio_servicio" IS NULL OR "fecha_fin_servicio" IS NULL OR "fecha_fin_servicio" >= "fecha_inicio_servicio");
-- Un pedido que no es borrador ni está anulado debe estar completo (Ventas lo "abre" cuando tiene todos los datos).
-- El bloque y los representantes no son obligatorios: no todo campo tiene bloque y los representantes pueden quedar pendientes.
ALTER TABLE "pedido" ADD CONSTRAINT "pedido_completo_check" CHECK (
  "estado" IN ('borrador', 'anulado') OR (
    "codigo" IS NOT NULL AND "cliente_id" IS NOT NULL AND "linea_servicio" IS NOT NULL AND "tipo_ot" IS NOT NULL
    AND "campo_id" IS NOT NULL AND "pozo_id" IS NOT NULL AND ("rigless" OR "taladro_id" IS NOT NULL)
    AND "numero_contrato" IS NOT NULL AND "fecha_inicio_servicio" IS NOT NULL AND "fecha_fin_servicio" IS NOT NULL
    AND "agente_comercial_id" IS NOT NULL AND "tecnico_hse_id" IS NOT NULL
  )
);
ALTER TABLE "pedido_tipo_servicio" ADD CONSTRAINT "pedido_tipo_servicio_check" CHECK ("tipo_servicio" IN (
  'wellbore_cleanup_tools', 'fishing_services', 'remedial_tools', 'completion_tools', 'lower_completion', 'milling',
  'casing_repair', 'thru_tubing', 'esp_equipment', 'flow_control_tools', 'liner_hanger', 'pesca_wireline_tools',
  'pipe_recovery', 'servicios_integrados', 'slickline', 'coiled_tubing', 'cementing'));
ALTER TABLE "pedido_item" ADD CONSTRAINT "pedido_item_cantidad_check" CHECK ("cantidad" > 0);
ALTER TABLE "pedido_item" ADD CONSTRAINT "pedido_item_valor_check" CHECK ("valor_unitario" >= 0);
ALTER TABLE "pedido_item" ADD CONSTRAINT "pedido_item_descuento_check" CHECK ("descuento_pct" IS NULL OR ("descuento_pct" >= 0 AND "descuento_pct" <= 100));
ALTER TABLE "pedido_item" ADD CONSTRAINT "pedido_item_origen_check" CHECK ("origen_item" IN ('lista', 'plantilla', 'as2', 'manual'));

-- Listas de precios
ALTER TABLE "lista_precios_item" ADD CONSTRAINT "lista_precios_item_tipo_check" CHECK ("tipo" IN ('Material', 'Servicio'));
ALTER TABLE "lista_precios_item" ADD CONSTRAINT "lista_precios_item_precio_check" CHECK ("precio" >= 0);

-- Los ítems y los hijos del pedido se reemplazan al editar: la aplicación necesita DELETE solo en estas tablas hijas
-- (el pedido en sí no se borra: se anula).
GRANT DELETE ON "pedido_item", "pedido_tipo_servicio", "pedido_subtipo_servicio" TO app_comercial;

COMMENT ON TABLE "proceso_estado" IS 'Catálogo de estados por proceso (pedido, prefactura...): nombre, macro-estado, responsable y si es final.';
COMMENT ON TABLE "proceso_transicion" IS 'Pasos válidos entre estados de un proceso, con el permiso que los dispara y si exigen motivo o los produce un hecho.';
COMMENT ON TABLE "proceso_historial" IS 'Seguimiento inmutable de cada cambio de estado de cualquier proceso.';
COMMENT ON TABLE "pedido" IS 'Pedido: entidad ancla del ciclo comercial. Catálogos como id + copia del nombre; sin FK a otros schemas.';
COMMENT ON TABLE "pedido_item" IS 'Ítems estimados del pedido; los nuevos salen siempre de la lista de precios del cliente.';
COMMENT ON TABLE "lista_precios" IS 'Lista de precios por cliente y contrato.';
