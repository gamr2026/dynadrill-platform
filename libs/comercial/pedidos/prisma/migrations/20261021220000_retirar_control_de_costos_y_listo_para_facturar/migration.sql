-- El cierre del pedido (control de costos y «listo para facturar») sale del alcance del aplicativo: el flujo de Facturación termina en la
-- prefactura firmada y, si el contrato la exige, la orden de trabajo. `facturado` se conserva como estado final (lo da el Superadmin, forzado).
-- Los pedidos que estaban en uno de los dos estados retirados vuelven al último paso que conserva el flujo, con su rastro en el historial.
WITH movidos AS (
  SELECT p.id, p.estado AS anterior,
         CASE WHEN EXISTS (SELECT 1 FROM orden_trabajo o WHERE o.pedido_id = p.id) THEN 'aot_generada' ELSE 'ticket_firmado' END AS nuevo
    FROM pedido p
   WHERE p.estado IN ('enviado_a_control_de_costos', 'listo_para_facturar')
), rastro AS (
  INSERT INTO proceso_historial (id, proceso, entidad_id, estado_anterior, estado_nuevo, macro_estado, motivo, origen)
  SELECT gen_random_uuid(), 'pedido', m.id, m.anterior, m.nuevo, 'en_proceso', 'paso retirado del flujo de Facturación', 'sistema'
    FROM movidos m
  RETURNING entidad_id
)
UPDATE pedido p SET estado = m.nuevo FROM movidos m WHERE m.id = p.id;

DELETE FROM proceso_transicion
 WHERE proceso = 'pedido'
   AND (estado_origen IN ('enviado_a_control_de_costos', 'listo_para_facturar')
     OR estado_destino IN ('enviado_a_control_de_costos', 'listo_para_facturar'));
DELETE FROM proceso_estado WHERE proceso = 'pedido' AND codigo IN ('enviado_a_control_de_costos', 'listo_para_facturar');
