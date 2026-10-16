-- La FK directa subtipo -> pedido era redundante: la FK compuesta (pedido_id, tipo_servicio) hacia
-- pedido_tipo_servicio ya garantiza que el pedido exista y que el tipo sea uno de los suyos.
ALTER TABLE "pedido_subtipo_servicio" DROP CONSTRAINT "pedido_subtipo_servicio_pedido_id_fkey";
