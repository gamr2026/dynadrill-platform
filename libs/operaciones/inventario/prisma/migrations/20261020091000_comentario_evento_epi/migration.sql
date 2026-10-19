-- El evento lleva el contenedor productor como prefijo (regla del bus de eventos).
COMMENT ON COLUMN "articulo"."entrega_personal" IS 'El artículo se entrega a una persona (EPI y ropa de trabajo, formato DYN-SGI-RE-032). QHSE lo recibe por el evento operaciones.inventario.articulo_epi_actualizado.';
