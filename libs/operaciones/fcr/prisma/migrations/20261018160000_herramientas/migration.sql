-- F2: configuración de códigos por cliente (qué es herramienta, con su kit de artículos), líneas cotizadas del pedido, herramientas del
-- ticket (precarga desde el pedido y flujo Supervisor → Bodega → Supervisor) y sus requisitos. Depende de `inventario` (artículos).
-- Spec de la demo: specs/fcr-precarga-herramientas.

CREATE TYPE "tipo_linea" AS ENUM ('servicio', 'material', 'herramienta', 'movilizacion');
CREATE TYPE "clasificacion_codigo" AS ENUM ('herramienta', 'servicio');
CREATE TYPE "origen_herramienta" AS ENUM ('pedido', 'manual');
CREATE TYPE "motivo_aviso_precarga" AS ENUM ('pedido_sin_cliente', 'sin_configurar', 'kit_vacio', 'articulo_inactivo');
CREATE TYPE "tipo_evento_herramienta" AS ENUM (
  'solicitada', 'preparada', 'preparada_con_novedad', 'enviada', 'recibida', 'recibida_con_novedad',
  'preparacion_corregida', 'recepcion_corregida', 'devuelta', 'faltante'
);

-- Los artículos y su categoría (misma base y mismo contenedor: FK reales a `inventario`)
GRANT USAGE ON SCHEMA inventario TO app_operaciones;
GRANT SELECT ON inventario.articulo, inventario.categoria_articulo, inventario.articulo_parte TO app_operaciones;

-- Solo los artículos de categorías con partes (herramientas) pueden ser herramienta de un kit o de un ticket: la regla vive en la base
CREATE FUNCTION fcr.exigir_articulo_herramienta() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM inventario.articulo a JOIN inventario.categoria_articulo c ON c.id = a.categoria_id
    WHERE a.id = NEW.articulo_id AND a.activo AND c.lleva_partes
  ) THEN
    RAISE EXCEPTION 'El artículo no es una herramienta activa del inventario (categoría con partes)' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Unidades de cotización (para decidir cuántos juegos de un kit se piden)
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE "unidad_cotizacion" (
    "id" UUID NOT NULL,
    "codigo" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "es_tiempo" BOOLEAN NOT NULL DEFAULT false,
    "orden" INTEGER NOT NULL,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    CONSTRAINT "unidad_cotizacion_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "unidad_cotizacion_codigo_key" UNIQUE ("codigo"),
    CONSTRAINT "unidad_cotizacion_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "unidad_cotizacion_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id")
);
COMMENT ON TABLE "unidad_cotizacion" IS 'Unidades en que se cotiza una línea del pedido. Si es de tiempo (día, hora, mes, semana) se pide un solo juego del kit: la cantidad son días de renta. El `codigo` es el nombre de la unidad sin tildes, en minúscula y en singular.';

-- ---------------------------------------------------------------------------------------------------------------
-- Configuración por cliente y código (aparte de la lista de precios, que se recrea al importar)
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE "configuracion_codigo" (
    "id" UUID NOT NULL,
    "cliente_id" UUID NOT NULL,
    "codigo" TEXT NOT NULL,
    "clasificacion" "clasificacion_codigo" NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID NOT NULL,
    CONSTRAINT "configuracion_codigo_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "configuracion_codigo_cliente_fkey" FOREIGN KEY ("cliente_id") REFERENCES catalogos.cliente ("id"),
    CONSTRAINT "configuracion_codigo_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "configuracion_codigo_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "configuracion_codigo_codigo_check" CHECK (length(btrim("codigo")) > 0)
);
CREATE UNIQUE INDEX "configuracion_codigo_cliente_codigo_key" ON "configuracion_codigo" ("cliente_id", "codigo");
-- la clasificación acompaña a la fila en la FK compuesta del kit: solo una `herramienta` puede tener kit
CREATE UNIQUE INDEX "configuracion_codigo_id_clasificacion_key" ON "configuracion_codigo" ("id", "clasificacion");
COMMENT ON TABLE "configuracion_codigo" IS 'Qué hace FCR con cada código de la lista de precios de un cliente: herramienta (con kit) o servicio. Un código sin fila se trata como servicio. La movilización no es una clase: la marca el pedido con su tipo de línea.';
COMMENT ON COLUMN "configuracion_codigo"."codigo" IS 'Código de la lista de precios o del pedido (de `comercial`, otro contenedor, D1): sin FK. La lista se recrea al importar, por eso la configuración vive aquí.';

CREATE TABLE "configuracion_codigo_kit" (
    "configuracion_id" UUID NOT NULL,
    "articulo_id" UUID NOT NULL,
    "cantidad" INTEGER NOT NULL,
    "clasificacion" "clasificacion_codigo" NOT NULL DEFAULT 'herramienta',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    CONSTRAINT "configuracion_codigo_kit_pkey" PRIMARY KEY ("configuracion_id", "articulo_id"),
    CONSTRAINT "configuracion_codigo_kit_configuracion_fkey" FOREIGN KEY ("configuracion_id", "clasificacion") REFERENCES "configuracion_codigo" ("id", "clasificacion") ON DELETE CASCADE,
    CONSTRAINT "configuracion_codigo_kit_articulo_fkey" FOREIGN KEY ("articulo_id") REFERENCES inventario.articulo ("id"),
    CONSTRAINT "configuracion_codigo_kit_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "configuracion_codigo_kit_cantidad_check" CHECK ("cantidad" BETWEEN 1 AND 999),
    CONSTRAINT "configuracion_codigo_kit_clasificacion_check" CHECK ("clasificacion" = 'herramienta')
);
CREATE INDEX "configuracion_codigo_kit_articulo_idx" ON "configuracion_codigo_kit" ("articulo_id");
CREATE TRIGGER "configuracion_codigo_kit_herramienta" BEFORE INSERT OR UPDATE OF "articulo_id" ON "configuracion_codigo_kit"
  FOR EACH ROW EXECUTE FUNCTION fcr.exigir_articulo_herramienta();
COMMENT ON TABLE "configuracion_codigo_kit" IS 'Kit de un código de herramienta: los artículos de Inventario (con partes) y cuántos de cada uno forman un juego. Se reemplaza completo al guardar.';
-- guardar un kit lo reemplaza (borra y vuelve a crear)
GRANT DELETE ON "configuracion_codigo_kit", "configuracion_codigo" TO app_operaciones;

-- ---------------------------------------------------------------------------------------------------------------
-- Líneas cotizadas del pedido (copia de otro contenedor, para armar y recargar la precarga)
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE "ticket_linea" (
    "id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "orden" SMALLINT NOT NULL,
    "codigo" TEXT NOT NULL,
    "descripcion" TEXT NOT NULL,
    "unidad" TEXT NOT NULL,
    "cantidad" NUMERIC(12,3) NOT NULL,
    "tipo_linea" "tipo_linea" NOT NULL,
    CONSTRAINT "ticket_linea_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ticket_linea_ticket_fkey" FOREIGN KEY ("ticket_id") REFERENCES "ticket" ("id") ON DELETE CASCADE,
    CONSTRAINT "ticket_linea_cantidad_check" CHECK ("cantidad" > 0)
);
CREATE UNIQUE INDEX "ticket_linea_orden_key" ON "ticket_linea" ("ticket_id", "orden");
CREATE INDEX "ticket_linea_codigo_idx" ON "ticket_linea" ("ticket_id", "codigo");
COMMENT ON TABLE "ticket_linea" IS 'Líneas cotizadas del pedido (código de la lista de precios, descripción, unidad, cantidad y tipo). Son de `comercial` (otro contenedor, D1): se copian porque no se pueden consultar con JOIN y se reemplazan completas cada vez que el pedido cambia (evento comercial.pedido.actualizado).';

-- ---------------------------------------------------------------------------------------------------------------
-- Herramientas del ticket
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE "ticket_herramienta" (
    "id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "articulo_id" UUID NOT NULL,
    "origen" "origen_herramienta" NOT NULL,
    "codigo_pedido" TEXT,
    "agregada_tarde" BOOLEAN NOT NULL DEFAULT false,
    "numero_serie" TEXT,
    "solicitada_at" TIMESTAMPTZ(6),
    "solicitada_por" UUID,
    "preparada_at" TIMESTAMPTZ(6),
    "preparada_por" UUID,
    "bodega_novedad" TEXT,
    "enviada_at" TIMESTAMPTZ(6),
    "enviada_por" UUID,
    "recibida_at" TIMESTAMPTZ(6),
    "recibida_por" UUID,
    "recepcion_novedad" TEXT,
    "devuelta_at" TIMESTAMPTZ(6),
    "devuelta_por" UUID,
    "faltante_at" TIMESTAMPTZ(6),
    "faltante_por" UUID,
    "faltante_motivo" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID NOT NULL,
    CONSTRAINT "ticket_herramienta_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ticket_herramienta_ticket_fkey" FOREIGN KEY ("ticket_id") REFERENCES "ticket" ("id") ON DELETE CASCADE,
    CONSTRAINT "ticket_herramienta_articulo_fkey" FOREIGN KEY ("articulo_id") REFERENCES inventario.articulo ("id"),
    CONSTRAINT "ticket_herramienta_solicitada_por_fkey" FOREIGN KEY ("solicitada_por") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "ticket_herramienta_preparada_por_fkey" FOREIGN KEY ("preparada_por") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "ticket_herramienta_enviada_por_fkey" FOREIGN KEY ("enviada_por") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "ticket_herramienta_recibida_por_fkey" FOREIGN KEY ("recibida_por") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "ticket_herramienta_devuelta_por_fkey" FOREIGN KEY ("devuelta_por") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "ticket_herramienta_faltante_por_fkey" FOREIGN KEY ("faltante_por") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "ticket_herramienta_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "ticket_herramienta_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id"),
    -- la herramienta de un kit viene de una línea del pedido; la manual, no
    CONSTRAINT "ticket_herramienta_origen_check" CHECK (("origen" = 'pedido') = ("codigo_pedido" IS NOT NULL)),
    -- cada marca lleva quién y cuándo, siempre juntos
    CONSTRAINT "ticket_herramienta_solicitada_check" CHECK (("solicitada_at" IS NULL) = ("solicitada_por" IS NULL)),
    CONSTRAINT "ticket_herramienta_preparada_check" CHECK (("preparada_at" IS NULL) = ("preparada_por" IS NULL)),
    CONSTRAINT "ticket_herramienta_enviada_check" CHECK (("enviada_at" IS NULL) = ("enviada_por" IS NULL)),
    CONSTRAINT "ticket_herramienta_recibida_check" CHECK (("recibida_at" IS NULL) = ("recibida_por" IS NULL)),
    CONSTRAINT "ticket_herramienta_devuelta_check" CHECK (("devuelta_at" IS NULL) = ("devuelta_por" IS NULL)),
    CONSTRAINT "ticket_herramienta_faltante_check" CHECK (
      ("faltante_at" IS NULL) = ("faltante_por" IS NULL) AND ("faltante_at" IS NULL) = ("faltante_motivo" IS NULL)
    ),
    -- el recorrido va en orden: solicitada → preparada → enviada → recibida → devuelta o faltante
    CONSTRAINT "ticket_herramienta_orden_check" CHECK (
      ("preparada_at" IS NULL OR "solicitada_at" IS NOT NULL)
      AND ("enviada_at" IS NULL OR "preparada_at" IS NOT NULL)
      AND ("recibida_at" IS NULL OR "enviada_at" IS NOT NULL)
      AND ("devuelta_at" IS NULL OR "recibida_at" IS NOT NULL)
      AND ("faltante_at" IS NULL OR "recibida_at" IS NOT NULL)
      AND ("devuelta_at" IS NULL OR "faltante_at" IS NULL)
    ),
    -- una marca con novedad no avanza: la novedad y la marca de ese paso no conviven
    CONSTRAINT "ticket_herramienta_novedad_check" CHECK (
      ("preparada_at" IS NULL OR "bodega_novedad" IS NULL) AND ("recibida_at" IS NULL OR "recepcion_novedad" IS NULL)
    ),
    CONSTRAINT "ticket_herramienta_texto_check" CHECK (
      length(btrim(coalesce("bodega_novedad", 'x'))) > 0 AND length(btrim(coalesce("recepcion_novedad", 'x'))) > 0
      AND length(btrim(coalesce("faltante_motivo", 'x'))) > 0
    )
);
CREATE INDEX "ticket_herramienta_ticket_idx" ON "ticket_herramienta" ("ticket_id");
CREATE INDEX "ticket_herramienta_articulo_idx" ON "ticket_herramienta" ("articulo_id");
-- las pendientes de Bodega (solicitadas y aún sin preparar) se consultan por todos los tickets
CREATE INDEX "ticket_herramienta_pendiente_bodega_idx" ON "ticket_herramienta" ("solicitada_at") WHERE "preparada_at" IS NULL AND "solicitada_at" IS NOT NULL;
-- solo se puede agregar una herramienta de verdad (categoría con partes, activa)
CREATE TRIGGER "ticket_herramienta_articulo_valido" BEFORE INSERT ON "ticket_herramienta"
  FOR EACH ROW EXECUTE FUNCTION fcr.exigir_articulo_herramienta();
-- recargar desde el pedido quita las herramientas que aún no se solicitaron
GRANT DELETE ON "ticket_herramienta", "ticket_linea" TO app_operaciones;
COMMENT ON TABLE "ticket_herramienta" IS 'Una herramienta física del ticket (un kit con 2 cepillos y 2 juegos son 4 filas de cepillo: Bodega, Recepción y la inspección se marcan por herramienta). El estado se deduce de las marcas; el detalle de cada marca queda en `ticket_herramienta_evento`.';
COMMENT ON COLUMN "ticket_herramienta"."codigo_pedido" IS 'Código de la línea del pedido (de `comercial`, otro contenedor: sin FK) de cuyo kit salió. No se llama `codigo` para no confundirlo con el del artículo.';
COMMENT ON COLUMN "ticket_herramienta"."agregada_tarde" IS 'Se agregó cuando el resto de la selección ya había salido a Bodega: se muestra aparte de la tanda original.';
COMMENT ON COLUMN "ticket_herramienta"."bodega_novedad" IS 'Novedad vigente que Bodega registró al preparar (la herramienta no avanza hasta resolverla). El historial queda en los eventos.';

-- Historia de lo que pasó con cada herramienta (inmutable)
CREATE TABLE "ticket_herramienta_evento" (
    "id" UUID NOT NULL,
    "herramienta_id" UUID NOT NULL,
    "tipo" "tipo_evento_herramienta" NOT NULL,
    "detalle" TEXT,
    "actor_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ticket_herramienta_evento_pkey" PRIMARY KEY ("id"),
    -- una herramienta con historia no se puede borrar
    CONSTRAINT "ticket_herramienta_evento_herramienta_fkey" FOREIGN KEY ("herramienta_id") REFERENCES "ticket_herramienta" ("id") ON DELETE RESTRICT,
    CONSTRAINT "ticket_herramienta_evento_actor_fkey" FOREIGN KEY ("actor_id") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "ticket_herramienta_evento_detalle_check" CHECK ("detalle" IS NULL OR length(btrim("detalle")) > 0),
    -- las novedades y los faltantes se explican
    CONSTRAINT "ticket_herramienta_evento_novedad_check" CHECK (
      "tipo" NOT IN ('preparada_con_novedad', 'recibida_con_novedad', 'faltante') OR "detalle" IS NOT NULL
    )
);
CREATE INDEX "ticket_herramienta_evento_herramienta_idx" ON "ticket_herramienta_evento" ("herramienta_id", "created_at");
REVOKE UPDATE, DELETE ON "ticket_herramienta_evento" FROM app_operaciones;
COMMENT ON TABLE "ticket_herramienta_evento" IS 'Historia inmutable de cada herramienta del ticket: solicitada, preparada (con o sin novedad), enviada, recibida, correcciones, devuelta o faltante.';

-- Avisos que la precarga deja al Supervisor (una línea sin kit, un artículo inactivo...)
CREATE TABLE "ticket_aviso_precarga" (
    "id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "motivo" "motivo_aviso_precarga" NOT NULL,
    "codigo" TEXT,
    "descripcion" TEXT,
    "articulo_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ticket_aviso_precarga_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ticket_aviso_precarga_ticket_fkey" FOREIGN KEY ("ticket_id") REFERENCES "ticket" ("id") ON DELETE CASCADE,
    CONSTRAINT "ticket_aviso_precarga_articulo_fkey" FOREIGN KEY ("articulo_id") REFERENCES inventario.articulo ("id"),
    CONSTRAINT "ticket_aviso_precarga_articulo_check" CHECK (("motivo" = 'articulo_inactivo') = ("articulo_id" IS NOT NULL))
);
CREATE INDEX "ticket_aviso_precarga_ticket_idx" ON "ticket_aviso_precarga" ("ticket_id");
-- cada precarga reemplaza los avisos de la anterior
GRANT DELETE ON "ticket_aviso_precarga" TO app_operaciones;
COMMENT ON TABLE "ticket_aviso_precarga" IS 'Lo que la precarga de herramientas no pudo resolver, para avisarle al Supervisor en vez de fallar en silencio. Se reemplaza en cada precarga.';
COMMENT ON COLUMN "ticket_aviso_precarga"."codigo" IS 'Código de la línea del pedido (de `comercial`, otro contenedor: sin FK).';
