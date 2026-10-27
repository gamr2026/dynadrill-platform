-- Estándar de la base de datos: toda tabla lleva su comentario en español (inventario, 6 tablas).
COMMENT ON TABLE inventario.articulo_codigo IS 'Códigos alternos de un artículo (de AS2 y de otros sistemas).';
COMMENT ON TABLE inventario.articulo_parte IS 'Parte (componente) de una herramienta: su lista de partes sirve para el checklist de inspección.';
COMMENT ON TABLE inventario.categoria_articulo IS 'Categoría de artículos (herramientas, químicos, repuestos...) y su comportamiento: si lleva partes, si es química.';
COMMENT ON TABLE inventario.despacho_item IS 'Ítem pedido en una solicitud de despacho (foto de la línea del pedido).';
COMMENT ON TABLE inventario.motivo_movimiento IS 'El motivo fija el tipo y el origen del movimiento; manual indica si la pantalla permite elegirlo.';
COMMENT ON TABLE inventario.subcategoria_articulo IS 'Subcategoría de artículos, dentro de una categoría.';
