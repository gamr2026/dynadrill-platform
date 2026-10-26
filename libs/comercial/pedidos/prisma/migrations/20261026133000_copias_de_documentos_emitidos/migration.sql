-- Auditoría de la base (26/10/2026): estas columnas de texto son COPIA deliberada del dato del documento emitido, no un catálogo olvidado.
-- Un documento emitido (prefactura, guía de remisión, orden de trabajo) debe imprimirse siempre igual aunque después se renombre la unidad, el
-- cliente o el chofer; por eso guardan el texto tal como salió. La unidad de los ítems del pedido, en cambio, sí es FK (CM-4).
COMMENT ON COLUMN "prefactura_item"."unidad" IS 'Copia del nombre de la unidad al emitir la prefactura (documento emitido: no cambia si se renombra la unidad del catálogo). Ver `pedido_item.unidad_medida_id`.';
COMMENT ON COLUMN "guia_remision_item"."unidad" IS 'Copia del nombre de la unidad tal como se imprime en la guía emitida (no cambia si se renombra la unidad del catálogo).';
COMMENT ON COLUMN "orden_trabajo_item"."unidad" IS 'Copia del nombre de la unidad tal como se imprime en la orden de trabajo (no cambia si se renombra la unidad del catálogo).';
COMMENT ON COLUMN "guia_remision"."cliente_nombre" IS 'Copia del nombre del cliente al emitir la guía (documento emitido).';
COMMENT ON COLUMN "guia_remision"."cliente_ruc" IS 'Copia del RUC del cliente al emitir la guía (documento emitido).';
COMMENT ON COLUMN "guia_remision"."chofer_nombre" IS 'Copia del nombre del chofer al emitir la guía; el chofer del catálogo va en `chofer_id`.';
COMMENT ON COLUMN "guia_remision"."transportista_nombre" IS 'Copia del nombre del transportista al emitir la guía; el del catálogo va en `transportista_id`.';
COMMENT ON COLUMN "guia_remision"."solicitado_por_nombre" IS 'Copia del nombre de quien solicitó el despacho, tal como se imprime en la guía.';
COMMENT ON COLUMN "guia_remision"."despachado_por_nombre" IS 'Copia del nombre de quien despachó, tal como se imprime en la guía.';
COMMENT ON COLUMN "orden_trabajo"."cliente_nombre" IS 'Copia del nombre del cliente al generar la orden de trabajo (documento emitido).';
COMMENT ON COLUMN "orden_trabajo"."contratista_nombre" IS 'Copia del nombre del contratista que firma la orden de trabajo (documento emitido).';
