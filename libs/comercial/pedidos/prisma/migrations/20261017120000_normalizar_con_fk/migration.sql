-- Normalización: los ids de catálogo y de personas pasan a ser FK reales (a `catalogos` e `identidad`) y desaparecen las copias de
-- nombre de los datos vivos. El nombre se obtiene con JOIN. Se conserva la copia solo en documentos emitidos (guía, orden de
-- trabajo, prefactura firmada). Decisión del 16/10/2026: ver documentacion/database/INVENTARIO-COPIAS-DE-NOMBRE.md.

-- ---------------------------------------------------------------------------------------------------------------
-- Lectura de las tablas maestras (solo lo necesario; de `identidad.usuario` nunca la clave ni los datos de acceso)
-- ---------------------------------------------------------------------------------------------------------------
GRANT USAGE ON SCHEMA catalogos, identidad TO app_comercial;
GRANT SELECT ON catalogos.cliente, catalogos.campo, catalogos.zona, catalogos.bloque, catalogos.pozo, catalogos.taladro,
  catalogos.bodega, catalogos.condicion_pago, catalogos.persona_contacto, catalogos.transportista, catalogos.vehiculo,
  catalogos.chofer TO app_comercial;
GRANT SELECT (id, nombre, email, activo) ON identidad.usuario TO app_comercial;

-- ---------------------------------------------------------------------------------------------------------------
-- Datos de AS2 que no tienen su registro en el catálogo: se conservan como datos de AS2 (no como nombre del catálogo)
-- ---------------------------------------------------------------------------------------------------------------
ALTER TABLE "pedido" ADD COLUMN "as2_empresa_nombre" TEXT,
  ADD COLUMN "as2_empresa_identificacion" TEXT,
  ADD COLUMN "as2_bodega" TEXT,
  ADD COLUMN "as2_condicion_pago" TEXT,
  ADD COLUMN "as2_zona" TEXT;

UPDATE "pedido" SET "as2_empresa_nombre" = "cliente_nombre", "as2_empresa_identificacion" = "cliente_ruc"
 WHERE "origen" = 'as2' AND "cliente_id" IS NULL;
UPDATE "pedido" SET "as2_bodega" = "bodega" WHERE "origen" = 'as2' AND "bodega_id" IS NULL;
UPDATE "pedido" SET "as2_condicion_pago" = "condicion_pago" WHERE "origen" = 'as2' AND "condicion_pago_id" IS NULL;
UPDATE "pedido" SET "as2_zona" = "zona" WHERE "origen" = 'as2' AND "campo_id" IS NULL;

-- ---------------------------------------------------------------------------------------------------------------
-- Pedido: copias de nombre fuera; FK a los catálogos y a las personas
-- ---------------------------------------------------------------------------------------------------------------
ALTER TABLE "pedido"
  DROP COLUMN "cliente_nombre", DROP COLUMN "cliente_ruc",
  DROP COLUMN "campo_nombre", DROP COLUMN "bloque_nombre", DROP COLUMN "pozo_nombre", DROP COLUMN "taladro_nombre",
  DROP COLUMN "agente_comercial_nombre", DROP COLUMN "representante_campo_nombre", DROP COLUMN "representante_quito_nombre",
  DROP COLUMN "tecnico_hse_nombre", DROP COLUMN "analista_facturacion_nombre",
  DROP COLUMN "despacho_solicitado_nombre", DROP COLUMN "despacho_realizado_nombre",
  -- la zona es la del campo (se obtiene del campo); bodega y condición de pago ya tienen su id con FK
  DROP COLUMN "zona_id", DROP COLUMN "zona", DROP COLUMN "bodega", DROP COLUMN "condicion_pago";

ALTER TABLE "pedido"
  ADD CONSTRAINT "pedido_cliente_id_fkey" FOREIGN KEY ("cliente_id") REFERENCES catalogos.cliente ("id"),
  ADD CONSTRAINT "pedido_campo_id_fkey" FOREIGN KEY ("campo_id") REFERENCES catalogos.campo ("id"),
  ADD CONSTRAINT "pedido_bloque_id_fkey" FOREIGN KEY ("bloque_id") REFERENCES catalogos.bloque ("id"),
  ADD CONSTRAINT "pedido_pozo_id_fkey" FOREIGN KEY ("pozo_id") REFERENCES catalogos.pozo ("id"),
  ADD CONSTRAINT "pedido_taladro_id_fkey" FOREIGN KEY ("taladro_id") REFERENCES catalogos.taladro ("id"),
  ADD CONSTRAINT "pedido_bodega_id_fkey" FOREIGN KEY ("bodega_id") REFERENCES catalogos.bodega ("id"),
  ADD CONSTRAINT "pedido_condicion_pago_id_fkey" FOREIGN KEY ("condicion_pago_id") REFERENCES catalogos.condicion_pago ("id"),
  ADD CONSTRAINT "pedido_representante_campo_id_fkey" FOREIGN KEY ("representante_campo_id") REFERENCES catalogos.persona_contacto ("id"),
  ADD CONSTRAINT "pedido_representante_quito_id_fkey" FOREIGN KEY ("representante_quito_id") REFERENCES catalogos.persona_contacto ("id"),
  ADD CONSTRAINT "pedido_agente_comercial_id_fkey" FOREIGN KEY ("agente_comercial_id") REFERENCES identidad.usuario ("id"),
  ADD CONSTRAINT "pedido_tecnico_hse_id_fkey" FOREIGN KEY ("tecnico_hse_id") REFERENCES identidad.usuario ("id"),
  ADD CONSTRAINT "pedido_analista_facturacion_id_fkey" FOREIGN KEY ("analista_facturacion_id") REFERENCES identidad.usuario ("id"),
  ADD CONSTRAINT "pedido_analista_asignado_por_fkey" FOREIGN KEY ("analista_asignado_por") REFERENCES identidad.usuario ("id"),
  ADD CONSTRAINT "pedido_facturado_por_fkey" FOREIGN KEY ("facturado_por") REFERENCES identidad.usuario ("id"),
  ADD CONSTRAINT "pedido_despacho_solicitado_por_fkey" FOREIGN KEY ("despacho_solicitado_por") REFERENCES identidad.usuario ("id"),
  ADD CONSTRAINT "pedido_despacho_realizado_por_fkey" FOREIGN KEY ("despacho_realizado_por") REFERENCES identidad.usuario ("id");

CREATE INDEX "pedido_campo_id_idx" ON "pedido" ("campo_id");
CREATE INDEX "pedido_pozo_id_idx" ON "pedido" ("pozo_id");

-- ---------------------------------------------------------------------------------------------------------------
-- Listas de precios, documentos operativos, prefacturas, guías, órdenes de trabajo, secuenciales e historial
-- ---------------------------------------------------------------------------------------------------------------
ALTER TABLE "lista_precios" DROP COLUMN "cliente_nombre",
  ADD CONSTRAINT "lista_precios_cliente_id_fkey" FOREIGN KEY ("cliente_id") REFERENCES catalogos.cliente ("id");

ALTER TABLE "documento_operativo" DROP COLUMN "supervisor_nombre", DROP COLUMN "operador_nombre",
  ADD CONSTRAINT "documento_operativo_supervisor_id_fkey" FOREIGN KEY ("supervisor_id") REFERENCES identidad.usuario ("id"),
  ADD CONSTRAINT "documento_operativo_operador_id_fkey" FOREIGN KEY ("operador_id") REFERENCES identidad.usuario ("id"),
  ADD CONSTRAINT "documento_operativo_recibido_por_fkey" FOREIGN KEY ("recibido_por") REFERENCES identidad.usuario ("id");

ALTER TABLE "prefactura"
  ADD CONSTRAINT "prefactura_generada_por_fkey" FOREIGN KEY ("generada_por") REFERENCES identidad.usuario ("id"),
  ADD CONSTRAINT "prefactura_enviada_por_fkey" FOREIGN KEY ("enviada_por") REFERENCES identidad.usuario ("id"),
  ADD CONSTRAINT "prefactura_rechazada_por_fkey" FOREIGN KEY ("rechazada_por") REFERENCES identidad.usuario ("id"),
  ADD CONSTRAINT "prefactura_anulada_por_fkey" FOREIGN KEY ("anulada_por") REFERENCES identidad.usuario ("id");

ALTER TABLE "prefactura_firma"
  ADD CONSTRAINT "prefactura_firma_persona_id_fkey" FOREIGN KEY ("persona_id") REFERENCES catalogos.persona_contacto ("id"),
  ADD CONSTRAINT "prefactura_firma_registrado_por_fkey" FOREIGN KEY ("registrado_por") REFERENCES identidad.usuario ("id");

-- Las dos columnas de "solicitado por / despachado por" con id no se usaban (la guía guarda el nombre tal como se imprimió).
ALTER TABLE "guia_remision" DROP COLUMN "solicitado_por_id", DROP COLUMN "despachado_por_id",
  ADD CONSTRAINT "guia_remision_transportista_id_fkey" FOREIGN KEY ("transportista_id") REFERENCES catalogos.transportista ("id"),
  ADD CONSTRAINT "guia_remision_vehiculo_id_fkey" FOREIGN KEY ("vehiculo_id") REFERENCES catalogos.vehiculo ("id"),
  ADD CONSTRAINT "guia_remision_chofer_id_fkey" FOREIGN KEY ("chofer_id") REFERENCES catalogos.chofer ("id"),
  ADD CONSTRAINT "guia_remision_emitida_por_fkey" FOREIGN KEY ("emitida_por") REFERENCES identidad.usuario ("id"),
  ADD CONSTRAINT "guia_remision_anulada_por_fkey" FOREIGN KEY ("anulada_por") REFERENCES identidad.usuario ("id");

ALTER TABLE "orden_trabajo"
  ADD CONSTRAINT "orden_trabajo_generada_por_fkey" FOREIGN KEY ("generada_por") REFERENCES identidad.usuario ("id"),
  ADD CONSTRAINT "orden_trabajo_firmada_por_fkey" FOREIGN KEY ("firmada_por") REFERENCES identidad.usuario ("id");

ALTER TABLE "pedido_documento"
  ADD CONSTRAINT "pedido_documento_subido_por_fkey" FOREIGN KEY ("subido_por") REFERENCES identidad.usuario ("id");

ALTER TABLE "secuencia_emision"
  ADD CONSTRAINT "secuencia_emision_emitido_por_fkey" FOREIGN KEY ("emitido_por") REFERENCES identidad.usuario ("id");

-- Historial de estados: quién lo hizo es su id (el nombre sale del JOIN); el rol con el que actuó se conserva porque es un dato
-- histórico (la persona puede cambiar de rol después).
ALTER TABLE "proceso_historial" DROP COLUMN "actor_nombre",
  ADD CONSTRAINT "proceso_historial_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES identidad.usuario ("id");
